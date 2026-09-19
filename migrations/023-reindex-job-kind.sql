-- 023: Reindex job kind + idempotent batch tracking (WP-545 Ф13)
--
-- Context: the webhook-triggered incremental reindex path (personal source push handling,
-- knowledge-mcp/src/index.ts /reindex) shares reindex_jobs and the "reindex" queue with the
-- existing full-tree reindex path (startReindexJob). Without a `kind` column, an incremental
-- job's completion would be indistinguishable from a full job's — handleQueue's completion
-- branch flips user_sources.index_state to 'ready' on ANY completed job for (user, source),
-- so a fast incremental job finishing mid-rebuild would wrongly mark the index 'ready' while
-- a full rebuild (kind='full') is still purging/repopulating it. kind restricts that flip,
-- the watchdog's failure flip, and findLiveReindexJob's "is a rebuild in flight" check to
-- kind='full' only (peer-session 2026-09-18-12-wp545-f13-reindex-impl, consensus with Kimi
-- and Codex).
--
-- completed_batch_indexes tracks which ReindexBatchMessage.batch_index values have already
-- been counted toward completed_batches, closing a redelivery double-count gap that existed
-- for both job kinds before this migration (Cloudflare Queues is at-least-once; a redelivered
-- batch used to increment completed_batches a second time, tripping the job into 'succeeded'
-- before every batch had actually run).

ALTER TABLE knowledge.reindex_jobs
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'full'
    CHECK (kind IN ('full', 'incremental'));

ALTER TABLE knowledge.reindex_jobs
  ADD COLUMN IF NOT EXISTS completed_batch_indexes INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
