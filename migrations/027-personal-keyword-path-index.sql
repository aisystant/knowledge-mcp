-- Target: persona database, knowledge.documents (all rows, no partial predicate).
-- Run on a dedicated connection with psql -v ON_ERROR_STOP=1 -f <this-file>.
-- Run OUTSIDE a transaction: do not use BEGIN, psql --single-transaction, or
-- a migration runner that wraps this file in a transaction.
-- Requires the existing pg_trgm extension. User/source access predicates in
-- personal keyword SQL remain unchanged; this does not change RLS or access.
--
-- A same-name index is deliberately an error, even if valid. Inspect its
-- definition, predicate, indisvalid and indisready before retrying. A failed
-- concurrent build may leave an INVALID index; do not silently skip it.
--
-- This supplies the missing filename branch of keyword search's OR condition.
-- It makes an indexed candidate path available, but does not guarantee the
-- planner will choose it or that production latency will improve. Measure
-- the exact unchanged keyword SQL before/after (plans, timings and results).
-- Do not change planner settings, run ANALYZE, or rewrite search in this step.
--
-- Rollback (separate command, outside a transaction; removes only this index):
-- DROP INDEX CONCURRENTLY knowledge.idx_documents_filename_trgm;

SET lock_timeout = '3s';
SET statement_timeout = '10min';

CREATE INDEX CONCURRENTLY idx_documents_filename_trgm
  ON knowledge.documents USING gin (filename gin_trgm_ops);

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_am am ON am.oid = c.relam
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    JOIN pg_opclass op ON op.oid = i.indclass[0]
    WHERE i.indexrelid = to_regclass('knowledge.idx_documents_filename_trgm')
      AND i.indrelid = 'knowledge.documents'::regclass
      AND i.indisvalid AND i.indisready
      AND i.indpred IS NULL AND i.indexprs IS NULL
      AND i.indnkeyatts = 1 AND i.indnatts = 1
      AND am.amname = 'gin' AND a.attname = 'filename'
      AND op.opcname = 'gin_trgm_ops'
  ) THEN
    RAISE EXCEPTION 'Personal keyword filename index is missing, invalid, not ready, or has the wrong definition; inspect before retrying';
  END IF;
END;
$verify$;

RESET statement_timeout;
RESET lock_timeout;
