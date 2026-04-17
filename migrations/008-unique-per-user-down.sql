-- Down migration for 008-unique-per-user.sql
-- USE WITH CAUTION: restoring single-owner UNIQUE will FAIL if any
-- two rows share (filename, source) across different user_ids.
--
-- Check for blockers before running:
--   SELECT filename, source, COUNT(*) FROM knowledge.documents
--   GROUP BY filename, source HAVING COUNT(*) > 1 LIMIT 5;
-- Non-empty result => down migration unsafe.

-- 1. Restore old UNIQUE (must be outside transaction in production)
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_documents_filename_source
  ON knowledge.documents (filename, source);

-- 2. Drop new index
DROP INDEX CONCURRENTLY IF EXISTS knowledge.idx_documents_fn_src_uid;

-- 3. Relax source_type constraints
ALTER TABLE knowledge.documents DROP CONSTRAINT IF EXISTS source_type_valid;
ALTER TABLE knowledge.documents ALTER COLUMN source_type DROP NOT NULL;
