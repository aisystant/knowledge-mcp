-- Target: knowledge database, public.knowledge_chunk (platform documents only).
-- Complements 026's platform path index; retain the existing global indexes.
-- Run on a dedicated connection with psql -v ON_ERROR_STOP=1 -f <this-file>.
-- Run OUTSIDE a transaction: no BEGIN, psql --single-transaction, or wrapping
-- migration runner. Requires the existing pg_trgm extension.
--
-- Both indexes exclude account-owned documents before bitmap heap rechecks.
-- Keyword SQL, ranking, access predicates and RLS remain unchanged. Measure
-- the exact original query's plans, candidate counts, timings and results
-- before/after. Availability of a smaller indexed candidate path does not
-- guarantee the planner will select it or that production latency improves.
-- Do not change planner settings or run ANALYZE as part of this migration.
--
-- Same-name indexes deliberately fail, including an INVALID prior build.
-- The two builds are independent: if the second fails, the first can remain
-- valid. Inspect definition/predicate/indisvalid/indisready for BOTH names
-- before retrying; never blindly rerun or drop a pre-existing global index.
--
-- Rollback: run these separately, OUTSIDE a transaction, after inspecting
-- which of this migration's two new indexes actually exist:
-- DROP INDEX CONCURRENTLY public.idx_kc_platform_content_trgm;
-- DROP INDEX CONCURRENTLY public.idx_kc_platform_fts;
-- This rollback preserves 026's path index and all existing global indexes.

SET lock_timeout = '3s';
SET statement_timeout = '10min';

CREATE INDEX CONCURRENTLY idx_kc_platform_content_trgm
  ON public.knowledge_chunk USING gin (content gin_trgm_ops)
  WHERE account_id IS NULL;

DO $verify_content$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_am am ON am.oid = c.relam
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    JOIN pg_opclass op ON op.oid = i.indclass[0]
    WHERE i.indexrelid = to_regclass('public.idx_kc_platform_content_trgm')
      AND i.indrelid = 'public.knowledge_chunk'::regclass
      AND i.indisvalid AND i.indisready
      AND pg_get_expr(i.indpred, i.indrelid) = '(account_id IS NULL)'
      AND i.indexprs IS NULL AND i.indnkeyatts = 1 AND i.indnatts = 1
      AND am.amname = 'gin' AND a.attname = 'content'
      AND op.opcname = 'gin_trgm_ops'
  ) THEN
    RAISE EXCEPTION 'Platform content index is missing, invalid, not ready, or has the wrong definition; inspect before retrying';
  END IF;
END;
$verify_content$;

CREATE INDEX CONCURRENTLY idx_kc_platform_fts
  ON public.knowledge_chunk USING gin (search_vector)
  WHERE account_id IS NULL;

DO $verify_fts$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_am am ON am.oid = c.relam
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    JOIN pg_opclass op ON op.oid = i.indclass[0]
    WHERE i.indexrelid = to_regclass('public.idx_kc_platform_fts')
      AND i.indrelid = 'public.knowledge_chunk'::regclass
      AND i.indisvalid AND i.indisready
      AND pg_get_expr(i.indpred, i.indrelid) = '(account_id IS NULL)'
      AND i.indexprs IS NULL AND i.indnkeyatts = 1 AND i.indnatts = 1
      AND am.amname = 'gin' AND a.attname = 'search_vector'
      AND op.opcname = 'tsvector_ops'
  ) THEN
    RAISE EXCEPTION 'Platform FTS index is missing, invalid, not ready, or has the wrong definition; inspect before retrying';
  END IF;
END;
$verify_fts$;

RESET statement_timeout;
RESET lock_timeout;
