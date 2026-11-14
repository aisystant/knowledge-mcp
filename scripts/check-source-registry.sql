\set ON_ERROR_STOP on

BEGIN;

INSERT INTO knowledge.sources
  (source_key, source_kind, repository_id, github_owner, github_repo, region)
VALUES
  ('github:1001', 'github', 1001, 'ExampleOrg', 'shared', 'test')
RETURNING id \gset shared_

INSERT INTO knowledge.sources
  (source_key, source_kind, repository_id, github_owner, github_repo, region)
VALUES
  ('github:1002', 'github', 1002, 'ExampleOrg', 'shared', 'test');

INSERT INTO knowledge.source_access_grants
  (source_id, subject_account_id, kind, required_mode, state)
VALUES
  ((SELECT id FROM knowledge.sources WHERE repository_id = 1001), 'account-a', 'github_right', 'account', 'active'),
  ((SELECT id FROM knowledge.sources WHERE repository_id = 1001), 'account-b', 'github_right', 'account', 'blocked'),
  ((SELECT id FROM knowledge.sources WHERE repository_id = 1001), NULL, 'platform_open', 'none', 'active');

DO $$
BEGIN
  BEGIN
    INSERT INTO knowledge.source_access_grants
      (source_id, subject_account_id, kind, required_mode, state)
    VALUES
      ((SELECT id FROM knowledge.sources WHERE repository_id = 1001), 'account-a', 'github_right', 'account', 'suspended');
    RAISE EXCEPTION 'duplicate named grant was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO knowledge.source_access_grants
      (source_id, subject_account_id, kind, required_mode, state)
    VALUES
      ((SELECT id FROM knowledge.sources WHERE repository_id = 1001), NULL, 'platform_open', 'none', 'suspended');
    RAISE EXCEPTION 'duplicate public grant was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO knowledge.source_access_grants
      (source_id, subject_account_id, kind, required_mode, state)
    VALUES
      ((SELECT id FROM knowledge.sources WHERE repository_id = 1001), NULL, 'github_right', 'account', 'active');
    RAISE EXCEPTION 'anonymous GitHub grant was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO knowledge.source_access_grants
      (source_id, subject_account_id, kind, required_mode, state)
    VALUES
      ((SELECT id FROM knowledge.sources WHERE repository_id = 1001), 'account-c', 'platform_open', 'none', 'active');
    RAISE EXCEPTION 'named platform grant was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;

INSERT INTO knowledge.source_access_decisions
  (grant_id, actor_account_id, reason, from_state, to_state, idempotency_key)
SELECT id, 'steward', 'access confirmed', 'blocked', 'active', 'decision-001'
FROM knowledge.source_access_grants
WHERE source_id = (SELECT id FROM knowledge.sources WHERE repository_id = 1001) AND subject_account_id = 'account-b';

UPDATE knowledge.source_access_grants
SET state = 'active', generation = generation + 1
WHERE source_id = (SELECT id FROM knowledge.sources WHERE repository_id = 1001) AND subject_account_id = 'account-b';

DO $$
DECLARE
  update_blocked BOOLEAN := false;
  delete_blocked BOOLEAN := false;
  truncate_blocked BOOLEAN := false;
BEGIN
  BEGIN
    INSERT INTO knowledge.source_access_decisions
      (grant_id, actor_account_id, reason, from_state, to_state, idempotency_key)
    SELECT id, 'steward', 'conflicting retry', 'active', 'revoked', 'decision-001'
    FROM knowledge.source_access_grants
    WHERE source_id = (SELECT id FROM knowledge.sources WHERE repository_id = 1001) AND subject_account_id = 'account-b';
    RAISE EXCEPTION 'conflicting idempotency key was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    UPDATE knowledge.source_access_decisions SET reason = 'rewrite' WHERE idempotency_key = 'decision-001';
  EXCEPTION WHEN raise_exception THEN update_blocked := true;
  END;
  IF NOT update_blocked THEN
    RAISE EXCEPTION 'journal update was accepted';
  END IF;

  BEGIN
    DELETE FROM knowledge.source_access_decisions WHERE idempotency_key = 'decision-001';
  EXCEPTION WHEN raise_exception THEN delete_blocked := true;
  END;
  IF NOT delete_blocked THEN
    RAISE EXCEPTION 'journal delete was accepted';
  END IF;

  BEGIN
    TRUNCATE knowledge.source_access_decisions;
  EXCEPTION WHEN raise_exception THEN truncate_blocked := true;
  END;
  IF NOT truncate_blocked THEN
    RAISE EXCEPTION 'journal truncate was accepted';
  END IF;
END;
$$;

DO $$
BEGIN
  IF (SELECT count(*) FROM knowledge.source_access_grants WHERE source_id = (SELECT id FROM knowledge.sources WHERE repository_id = 1001)) <> 3 THEN
    RAISE EXCEPTION 'unexpected grant count';
  END IF;
  IF (SELECT count(*) FROM knowledge.source_access_decisions) <> 1 THEN
    RAISE EXCEPTION 'unexpected journal count';
  END IF;
END;
$$;

COMMIT;
