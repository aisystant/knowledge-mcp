-- Run as the migration owner in a DISPOSABLE PostgreSQL >=15 database.
-- Transaction rolls back test roles/data; the migration is applied separately.
\set ON_ERROR_STOP on
BEGIN;
CREATE ROLE wp579_test_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA retrieval TO wp579_test_runtime;
GRANT SELECT,INSERT ON retrieval.observation TO wp579_test_runtime;
GRANT SELECT ON retrieval.observation_export TO wp579_test_runtime;
GRANT SELECT,INSERT,UPDATE ON retrieval.citation_feedback TO wp579_test_runtime;
GRANT EXECUTE ON FUNCTION retrieval.expire_observations() TO wp579_test_runtime;
INSERT INTO retrieval.observation
 (account_id,id,mode,observed_at,query_fingerprint,query_text,text_expires_at,text_disposition,snapshot)
VALUES
 ('a','00000000-0000-4000-8000-000000000001','public',now()-interval '2 days',repeat('a',64),'expired test',now()-interval '1 day','retained','{"hits":[{"id":10}]}'),
 ('b','00000000-0000-4000-8000-000000000002','public',now(),repeat('b',64),'current test',now()+interval '1 day','retained','{"hits":[{"id":20}]}'),
 ('a','00000000-0000-4000-8000-000000000003','public',now()-interval '2160 hours',repeat('a',64),NULL,NULL,'disabled','{"hits":[{"id":30}]}'),
 ('a','00000000-0000-4000-8000-000000000004','public',now()-interval '2184 hours',repeat('a',64),'old raw test',now()-interval '24 hours','retained','{"hits":[{"id":40}]}'),
 ('a','00000000-0000-4000-8000-000000000005','private',now()-interval '2184 hours',repeat('a',64),NULL,NULL,'private','{"hits":[{"id":50}]}'),
 ('a','00000000-0000-4000-8000-000000000006','public',now()-interval '2159 hours',repeat('a',64),NULL,NULL,'filtered','{"hits":[]}');
INSERT INTO retrieval.citation_feedback(account_id,observation_id,document_id,helpfulness)
VALUES ('a','00000000-0000-4000-8000-000000000003',30,true),
       ('a','00000000-0000-4000-8000-000000000004',40,true),
       ('a','00000000-0000-4000-8000-000000000005',50,true);
-- Absolute hours work across DST; a calendar-day cap would reject some boundaries.
SAVEPOINT dst_boundary;
SET LOCAL TIME ZONE 'America/New_York';
INSERT INTO retrieval.observation
 (account_id,id,mode,observed_at,query_fingerprint,query_text,text_expires_at,text_disposition,snapshot)
VALUES ('dst','00000000-0000-4000-8000-000000000007','public','2026-01-01 00:00:00+00',repeat('a',64),
 'test','2026-01-01 00:00:00+00'::timestamptz + interval '2160 hours','retained','{"hits":[]}');
ROLLBACK TO SAVEPOINT dst_boundary;
SET LOCAL ROLE wp579_test_runtime;
DO $$ BEGIN
 IF (SELECT r.rolsuper OR r.rolbypassrls OR pg_has_role(current_user,c.relowner,'MEMBER')
     FROM pg_roles r CROSS JOIN pg_class c
     WHERE r.rolname=current_user AND c.oid='retrieval.observation'::regclass)
 THEN RAISE EXCEPTION 'ordinary runtime incorrectly rejected by guard'; END IF;
 IF (SELECT count(*) FROM retrieval.observation) <> 0 THEN RAISE EXCEPTION 'unbound role can read rows'; END IF;
END $$;
SELECT set_config('app.account_id','a',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM retrieval.observation) <> 2 THEN RAISE EXCEPTION 'account isolation or expiry gate failed'; END IF;
 IF EXISTS (SELECT 1 FROM retrieval.citation_feedback) THEN RAISE EXCEPTION 'expired feedback visible before cleanup'; END IF;
 IF EXISTS (SELECT 1 FROM retrieval.observation_export WHERE query_text IS NOT NULL) THEN RAISE EXCEPTION 'export exposed expired text'; END IF;
 IF NOT EXISTS (SELECT 1 FROM retrieval.observation_export
   WHERE id='00000000-0000-4000-8000-000000000006' AND expires_at=observed_at+interval '2160 hours')
 THEN RAISE EXCEPTION 'hash-only export lost original expiry'; END IF;
 BEGIN
  INSERT INTO retrieval.observation (account_id,id,mode,observed_at,query_fingerprint,text_disposition,snapshot)
  VALUES ('b','00000000-0000-4000-8000-000000000003','public',now(),repeat('b',64),'disabled','{"hits":[]}');
  RAISE EXCEPTION 'cross-account insert succeeded';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  INSERT INTO retrieval.citation_feedback(account_id,observation_id,document_id,helpfulness)
  VALUES ('b','00000000-0000-4000-8000-000000000002',20,true);
  RAISE EXCEPTION 'cross-account feedback succeeded';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  INSERT INTO retrieval.citation_feedback(account_id,observation_id,document_id,helpfulness)
  VALUES ('a','00000000-0000-4000-8000-000000000002',20,true);
  RAISE EXCEPTION 'cross-account foreign key succeeded';
 EXCEPTION WHEN foreign_key_violation OR insufficient_privilege THEN NULL; END;
 BEGIN
  INSERT INTO retrieval.observation(account_id,id,mode,observed_at,query_fingerprint,text_disposition,snapshot)
  VALUES ('a','00000000-0000-4000-8000-000000000008','public',now()+interval '1 day',repeat('a',64),'disabled','{"hits":[]}');
  RAISE EXCEPTION 'future timestamp extended lifetime';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  INSERT INTO retrieval.observation(account_id,id,mode,observed_at,query_fingerprint,text_disposition,snapshot)
  VALUES ('a','00000000-0000-4000-8000-000000000008','public',now()-interval '2184 hours',repeat('a',64),'disabled','{"hits":[]}');
  RAISE EXCEPTION 'expired observation reinserted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  INSERT INTO retrieval.observation(account_id,id,mode,observed_at,query_fingerprint,query_text,text_expires_at,text_disposition,snapshot)
  VALUES ('a','00000000-0000-4000-8000-000000000008','public',now(),repeat('a',64),'test',now()+interval '2184 hours','retained','{"hits":[]}');
  RAISE EXCEPTION 'text window over 90 days accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
INSERT INTO retrieval.citation_feedback(account_id,observation_id,document_id,helpfulness,cited)
VALUES ('a','00000000-0000-4000-8000-000000000001',10,false,true);
-- Reuse the SAME connection for another account; SET LOCAL must not leak afterward.
SAVEPOINT second_account;
SELECT set_config('app.account_id','b',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM retrieval.observation) <> 1 OR EXISTS (SELECT 1 FROM retrieval.citation_feedback)
 THEN RAISE EXCEPTION 'reused connection leaked previous account'; END IF;
END $$;
ROLLBACK TO SAVEPOINT second_account;
DO $$ BEGIN
 IF current_setting('app.account_id') <> 'a' THEN RAISE EXCEPTION 'rollback retained wrong account'; END IF;
 IF retrieval.expire_observations() <> 4 THEN RAISE EXCEPTION 'expiry count mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM retrieval.observation WHERE query_text IS NOT NULL) THEN RAISE EXCEPTION 'text not physically scrubbed'; END IF;
 IF NOT EXISTS (SELECT 1 FROM retrieval.citation_feedback WHERE cited AND NOT helpfulness)
 THEN RAISE EXCEPTION 'citation/helpfulness conflated'; END IF;
END $$;
SELECT set_config('app.account_id','b',true);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM retrieval.observation WHERE query_text='current test') THEN RAISE EXCEPTION 'expiry removed unexpired text'; END IF;
END $$;
-- A transaction opened before text expiry must not expose it in a later statement.
SAVEPOINT text_clock;
INSERT INTO retrieval.observation
 (account_id,id,mode,observed_at,query_fingerprint,query_text,text_expires_at,text_disposition,snapshot)
VALUES ('b','00000000-0000-4000-8000-000000000009','public',statement_timestamp(),repeat('b',64),
 'clock test',statement_timestamp()+interval '0.1 seconds','retained','{"hits":[]}');
SELECT pg_sleep(0.2);
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM retrieval.observation_export
   WHERE id='00000000-0000-4000-8000-000000000009' AND query_text IS NOT NULL)
 THEN RAISE EXCEPTION 'transaction clock extended text visibility'; END IF;
END $$;
ROLLBACK TO SAVEPOINT text_clock;
RESET ROLE;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM retrieval.observation WHERE id IN (
   '00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000005'))
 THEN RAISE EXCEPTION 'expired metadata/hash/private records not physically deleted'; END IF;
 IF EXISTS (SELECT 1 FROM retrieval.citation_feedback WHERE document_id IN (30,40,50))
 THEN RAISE EXCEPTION 'expired feedback not cascade-deleted'; END IF;
 IF retrieval.expire_observations() <> 0 THEN RAISE EXCEPTION 'cleanup not idempotent'; END IF;
END $$;
ROLLBACK;
\echo 'RLS, cross-account feedback, connection reuse and retention verified'
