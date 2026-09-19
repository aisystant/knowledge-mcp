-- Run as the migration owner in a DISPOSABLE PostgreSQL >=15 database.
-- Transaction rolls back test roles/data; the migration is applied separately.
\set ON_ERROR_STOP on
BEGIN;
CREATE ROLE wp579_test_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA retrieval TO wp579_test_runtime;
GRANT SELECT,INSERT ON retrieval.observation TO wp579_test_runtime;
GRANT SELECT ON retrieval.observation_export TO wp579_test_runtime;
GRANT SELECT,INSERT,UPDATE ON retrieval.citation_feedback TO wp579_test_runtime;
GRANT EXECUTE ON FUNCTION retrieval.expire_text() TO wp579_test_runtime;
INSERT INTO retrieval.observation
 (account_id,id,mode,observed_at,query_fingerprint,query_text,text_expires_at,text_disposition,snapshot)
VALUES
 ('a','00000000-0000-4000-8000-000000000001','public',now()-interval '2 days',repeat('a',64),'expired test',now()-interval '1 day','retained','{"hits":[{"id":10}]}'),
 ('b','00000000-0000-4000-8000-000000000002','public',now(),repeat('b',64),'current test',now()+interval '1 day','retained','{"hits":[{"id":20}]}');
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
 IF (SELECT count(*) FROM retrieval.observation) <> 1 THEN RAISE EXCEPTION 'account isolation failed'; END IF;
 IF EXISTS (SELECT 1 FROM retrieval.observation_export WHERE query_text IS NOT NULL) THEN RAISE EXCEPTION 'export exposed expired text'; END IF;
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
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
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
 IF retrieval.expire_text() <> 1 THEN RAISE EXCEPTION 'expiry count mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM retrieval.observation WHERE query_text IS NOT NULL) THEN RAISE EXCEPTION 'text not physically scrubbed'; END IF;
 IF NOT EXISTS (SELECT 1 FROM retrieval.citation_feedback WHERE cited AND NOT helpfulness)
 THEN RAISE EXCEPTION 'citation/helpfulness conflated'; END IF;
END $$;
SELECT set_config('app.account_id','b',true);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM retrieval.observation WHERE query_text='current test') THEN RAISE EXCEPTION 'expiry removed unexpired text'; END IF;
END $$;
ROLLBACK;
\echo 'RLS, cross-account feedback, connection reuse and retention verified'
