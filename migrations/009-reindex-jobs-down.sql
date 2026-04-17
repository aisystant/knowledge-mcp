-- 009 rollback: drop reindex_jobs + auto_reindex_enabled.
-- Only use if Ф-K.1 is reverted entirely. Column drop is destructive (opt-out settings lost).

ALTER TABLE knowledge.user_sources DROP COLUMN IF EXISTS auto_reindex_enabled;
DROP TABLE IF EXISTS knowledge.reindex_jobs;
