-- Test rollback only: refuse to destroy an audit journal that contains decisions.

BEGIN;
LOCK TABLE knowledge.source_access_decisions IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM knowledge.source_access_decisions) THEN
    RAISE EXCEPTION 'refusing to drop non-empty source_access_decisions';
  END IF;
END;
$$;

DROP TABLE knowledge.source_access_decisions;
DROP TABLE knowledge.source_access_grants;
DROP TABLE knowledge.sources;
DROP FUNCTION knowledge.reject_source_access_decision_mutation();
COMMIT;
