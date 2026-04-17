-- WP-187 Ф-J.1d — CONCURRENTLY index swap (run OUTSIDE transaction in Neon SQL editor)
-- Run AFTER 008-unique-per-user.sql and AFTER deploying code with updated ON CONFLICT.
--
-- Order matters:
--   1. Apply 008-unique-per-user.sql (backfill + CHECK).
--   2. Create new expression UNIQUE index.
--   3. Deploy knowledge-mcp + pk-mcp with new ON CONFLICT expression.
--   4. Drop old index.
-- Never drop the old index before step 3 — a window without any UNIQUE
-- constraint on (filename, source) allows duplicate inserts.

-- 1. Create new UNIQUE index concurrently (does not block writes).
-- user_id is TEXT in this schema, not UUID — sentinel is empty string.
-- Empty string must NOT be a valid user_id elsewhere (verified pre-migration).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_documents_fn_src_uid
  ON knowledge.documents (filename, source, COALESCE(user_id, ''));

-- 2. Verify it is valid (INVALID index is useless)
SELECT indexname, indisvalid
FROM pg_indexes pi
JOIN pg_class c ON c.relname = pi.indexname
JOIN pg_index pgi ON pgi.indexrelid = c.oid
WHERE pi.schemaname = 'knowledge'
  AND pi.tablename = 'documents'
  AND pi.indexname = 'idx_documents_fn_src_uid';

-- 3. Only AFTER code deploy: drop the old index
-- DROP INDEX CONCURRENTLY IF EXISTS knowledge.idx_documents_filename_source;
