-- 025: grants on the batched full-ingest tables for the worker's database role (WP-532 Ф9)
--
-- Migration 024 created full_ingest_runs and knowledge_chunk_staging owned by the migration
-- role, so the worker role (knowledge_app_reader, the only non-owner role with write access to
-- knowledge_chunk) had no access: the first nightly run failed with
-- "permission denied for table full_ingest_runs" (2026-09-30 00:38 UTC). Applied to production
-- by hand on 2026-09-30; this file makes it reproducible. Least privilege: only these objects.
--
-- Apply: psql "$KNOWLEDGE_DIRECT" -v ON_ERROR_STOP=1 -f migrations/025-full-ingest-grants.sql
-- Rollback: REVOKE the same privileges (and USAGE, SELECT on the sequence) from the role.

BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON full_ingest_runs, knowledge_chunk_staging TO knowledge_app_reader;
GRANT USAGE, SELECT ON SEQUENCE knowledge_chunk_staging_staging_id_seq TO knowledge_app_reader;

COMMIT;
