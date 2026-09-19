-- Run once as the migration owner after migration 024, in the selected database.
-- Both roles remain NOLOGIN; no passwords or Worker configuration are changed.
-- Existing same-named roles are an error, not silently adopted.
BEGIN;
CREATE ROLE retrieval_observation_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS
  NOCREATEROLE NOCREATEDB NOREPLICATION;
CREATE ROLE retrieval_observation_monitor NOLOGIN NOSUPERUSER NOBYPASSRLS
  NOCREATEROLE NOCREATEDB NOREPLICATION;
GRANT USAGE ON SCHEMA retrieval TO retrieval_observation_runtime, retrieval_observation_monitor;
GRANT SELECT, INSERT ON retrieval.observation TO retrieval_observation_runtime;
GRANT SELECT, INSERT, UPDATE ON retrieval.citation_feedback TO retrieval_observation_runtime;
GRANT SELECT ON retrieval.observation_export TO retrieval_observation_runtime;
GRANT EXECUTE ON FUNCTION retrieval.expire_observations() TO retrieval_observation_runtime;
GRANT EXECUTE ON FUNCTION retrieval.maintenance_status() TO retrieval_observation_monitor;

DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['retrieval_observation_runtime','retrieval_observation_monitor'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolcanlogin))
      OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=role_name)
    THEN RAISE EXCEPTION 'observation role must be isolated and NOLOGIN'; END IF;
    IF NOT has_database_privilege(role_name,current_database(),'CONNECT')
      OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%'
        AND n.nspname<>'information_schema' AND has_schema_privilege(role_name,n.oid,'CREATE'))
    THEN RAISE EXCEPTION 'unexpected database/schema privileges'; END IF;
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT LIKE 'pg_%'
      AND n.nspname NOT IN ('information_schema','retrieval')
      AND (has_table_privilege(role_name,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(role_name,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
    THEN RAISE EXCEPTION 'role inherits unrelated application access'; END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE p.prosecdef AND n.nspname NOT LIKE 'pg_%' AND n.nspname NOT IN ('information_schema','retrieval')
        AND has_function_privilege(role_name,p.oid,'EXECUTE'))
    THEN RAISE EXCEPTION 'role inherits unrelated definer function access'; END IF;
  END LOOP;
  IF has_table_privilege('retrieval_observation_runtime','retrieval.observation','UPDATE,DELETE,TRUNCATE')
    OR has_table_privilege('retrieval_observation_runtime','retrieval.citation_feedback','DELETE,TRUNCATE')
    OR has_table_privilege('retrieval_observation_runtime','retrieval.maintenance_state','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    OR has_function_privilege('retrieval_observation_runtime','retrieval.maintenance_status()','EXECUTE')
    OR has_function_privilege('retrieval_observation_monitor','retrieval.expire_observations()','EXECUTE')
    OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='retrieval' AND c.relkind IN ('r','p','v')
        AND has_table_privilege('retrieval_observation_monitor',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
  THEN RAISE EXCEPTION 'unexpected observation role grant'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid IN ('retrieval.observation'::regclass,'retrieval.citation_feedback'::regclass)
    AND NOT (relrowsecurity AND relforcerowsecurity))
    OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='retrieval.observation_export'::regclass
      AND relkind='v' AND 'security_invoker=true'=ANY(reloptions))
  THEN RAISE EXCEPTION 'observation isolation configuration invalid'; END IF;
END $$;
COMMIT;
