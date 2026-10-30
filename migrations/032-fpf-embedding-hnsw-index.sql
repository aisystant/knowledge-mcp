-- Target: knowledge database, public.knowledge_chunk (platform FPF documents only).
-- WP-596 Ф10 п.12: a vector search with `source = 'FPF'` against the shared HNSW index
-- scans the 40 nearest chunks of ANY source and then drops the non-FPF ones; for a Russian
-- query those are mostly Russian documents, so the FPF-filtered result is empty. Measured
-- 30.10.2026 (read-only): 0 of 20 rows without iterative scan, 13 of 20 in 235 ms with it.
-- A dedicated index over FPF rows makes the filtered search start from FPF neighbours.
--
-- Security review (AR.112, manual): the table also holds account-owned rows. This index
-- covers only rows with account_id IS NULL and source = 'FPF', so no per-account embedding
-- is indexed; the DO block below fails the migration if the stored predicate differs. The
-- block reads only pg_catalog views, no row data and no dynamic SQL built from input.
-- The automated detector flags any statement on this table for manual review by design.
--
-- Run on a dedicated connection with psql -v ON_ERROR_STOP=1 -f <this-file>.
-- Run OUTSIDE a transaction: no BEGIN, psql --single-transaction, or wrapping
-- migration runner (CREATE INDEX CONCURRENTLY cannot run inside one).
--
-- BEFORE running:
--  1. Read the definition of the existing index and copy its operator class and WITH options
--     (m, ef_construction) into the statement below if they are not the defaults:
--       SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_kc_embedding_hnsw';
--  2. Check that the planner can use the partial index for the exact production query. The
--     predicate of a partial index must be provable from the query's WHERE clause; the query
--     passes the source as a bound parameter, which is planned with the actual value only for
--     an unnamed statement. Run EXPLAIN on the same SQL with a real vector and source = 'FPF'
--     AFTER the build and confirm the plan names idx_kc_fpf_embedding_hnsw. If it does not,
--     drop the index (rollback below) and do not rely on it.
--  3. Measure build time and index size on a branch first; a nightly reindex of the 25 825 FPF
--     rows rewrites this index too.
--
-- Same-name index deliberately fails, including an INVALID prior build: inspect
-- definition/indisvalid/indisready for the name before retrying; never blindly rerun.
--
-- Rollback (OUTSIDE a transaction): DROP INDEX CONCURRENTLY public.idx_kc_fpf_embedding_hnsw;
-- The shared idx_kc_embedding_hnsw and every other index stay untouched.

SET lock_timeout = '3s';
SET statement_timeout = '30min';

CREATE INDEX CONCURRENTLY idx_kc_fpf_embedding_hnsw
  ON public.knowledge_chunk USING hnsw (embedding vector_cosine_ops)
  WHERE source = 'FPF' AND account_id IS NULL AND embedding IS NOT NULL;

-- A failed CONCURRENTLY build leaves an INVALID index and psql would still exit 0: check it.
DO $verify_fpf$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_am am ON am.oid = c.relam
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    JOIN pg_opclass op ON op.oid = i.indclass[0]
    WHERE i.indexrelid = to_regclass('public.idx_kc_fpf_embedding_hnsw')
      AND i.indrelid = 'public.knowledge_chunk'::regclass
      AND i.indisvalid AND i.indisready
      AND i.indexprs IS NULL AND i.indnkeyatts = 1 AND i.indnatts = 1
      AND am.amname = 'hnsw' AND a.attname = 'embedding'
      AND op.opcname = 'vector_cosine_ops'
      AND pg_get_expr(i.indpred, i.indrelid) LIKE '%source%FPF%'
      AND pg_get_expr(i.indpred, i.indrelid) LIKE '%account_id IS NULL%'
      AND pg_get_expr(i.indpred, i.indrelid) LIKE '%embedding IS NOT NULL%'
  ) THEN
    RAISE EXCEPTION 'FPF embedding index is missing, invalid, not ready, or has the wrong definition; inspect before retrying';
  END IF;
END;
$verify_fpf$;

RESET statement_timeout;
RESET lock_timeout;
