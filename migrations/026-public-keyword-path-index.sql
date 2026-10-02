-- Target: knowledge database, public.knowledge_chunk (platform documents only).
-- Run on a dedicated connection with psql -v ON_ERROR_STOP=1 -f <this-file>.
-- Run OUTSIDE a transaction: do not use BEGIN, psql --single-transaction, or
-- a migration runner that wraps this file in a transaction.
-- Requires the existing pg_trgm extension; no private-table or RLS changes.
--
-- A same-name index is deliberately an error, even if valid. Inspect its
-- definition, predicate, indisvalid and indisready before retrying. A failed
-- concurrent build may leave an INVALID index; do not silently skip it.
--
-- This supplies the missing path branch of keyword search's OR condition.
-- It makes an indexed candidate path available, but does not guarantee the
-- planner will choose it or that production latency will improve. Measure
-- the exact unchanged keyword SQL before/after (plans, timings and results).
-- Do not change planner settings, run ANALYZE, or rewrite search in this step.
--
-- Rollback (separate command, outside a transaction; removes only this index):
-- DROP INDEX CONCURRENTLY public.idx_kc_platform_source_uri_trgm;

SET lock_timeout = '3s';
SET statement_timeout = '10min';

CREATE INDEX CONCURRENTLY idx_kc_platform_source_uri_trgm
  ON public.knowledge_chunk USING gin (source_uri gin_trgm_ops)
  WHERE account_id IS NULL;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index
    WHERE indexrelid = to_regclass('public.idx_kc_platform_source_uri_trgm')
      AND indrelid = 'public.knowledge_chunk'::regclass
      AND indisvalid AND indisready
      AND pg_get_expr(indpred, indrelid) = '(account_id IS NULL)'
  ) THEN
    RAISE EXCEPTION 'Platform keyword path index is missing, invalid, not ready, or has the wrong predicate; inspect before retrying';
  END IF;
END
$verify$;

RESET statement_timeout;
RESET lock_timeout;
