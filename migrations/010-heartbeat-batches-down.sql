-- 010 down: revert heartbeat + batch accounting
DROP INDEX IF EXISTS knowledge.idx_reindex_jobs_running_heartbeat;

ALTER TABLE knowledge.reindex_jobs
  DROP COLUMN IF EXISTS completed_batches,
  DROP COLUMN IF EXISTS expected_batches,
  DROP COLUMN IF EXISTS last_heartbeat_at;
