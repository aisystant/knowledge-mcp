-- 023 rollback: drop kind + completed_batch_indexes.

ALTER TABLE knowledge.reindex_jobs DROP COLUMN IF EXISTS kind;
ALTER TABLE knowledge.reindex_jobs DROP COLUMN IF EXISTS completed_batch_indexes;
