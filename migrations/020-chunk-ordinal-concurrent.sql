-- WP-7 Ф94 — CONCURRENTLY index swap for chunk_ordinal (run OUTSIDE transaction in Neon SQL editor)
--
-- "Idempotent" only means retry-safe, not self-healing (Codex, round 4 of the
-- Kimi+Codex peer session, 2026-08-29): a reindex error in the deploy/index-swap
-- gap does not fix itself — the earlier draft of this runbook understated that.
-- Correct sequence (short bounded pause of reindex writes, distinct from the
-- broader multi-source drain problem this WP already solved without a pause —
-- that one covers "how do we know old writers everywhere have stopped"; this
-- one is a narrow "swap one index safely" step that's fine to pause briefly for):
--
--   1. Apply 020-chunk-ordinal.sql (adds chunk_ordinal, protocol_version).
--   2. Create new expression UNIQUE index (this file, step 1). Verify
--      indisvalid = true (step 2) before proceeding — if a prior attempt left
--      an INVALID index of the same name, `IF NOT EXISTS` silently skips
--      creating a working one; DROP INDEX CONCURRENTLY the invalid one first,
--      then re-run step 1.
--   3. Pause reindex write entry points on both services (webhook + queue
--      consumer) and wait for in-flight requests to finish.
--   4. Deploy personal-knowledge-mcp + knowledge-mcp with chunk_ordinal-aware
--      writes; confirm the new version is serving traffic.
--   5. Immediately drop the old index (this file, step 3 — commented, run
--      right after step 4 confirms live).
--   6. Resume writes; explicitly replay reindex for any file whose write
--      landed in the step 3-5 window (it will not retry itself).
--   7. Live-verify get_document on a real multi-chunk file.
--
-- If pausing writers end-to-end isn't practical, the alternative Codex proposed
-- is a compatibility release that writes chunk_ordinal but never more than one
-- row per (filename, source, user_id) until the old index is gone — that keeps
-- every write conflict-free under both indexes at once, at the cost of a
-- transitional deploy that doesn't yet fix multi-chunk documents.

-- 1. New UNIQUE index, does not block writes.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_documents_fn_src_uid_ord
  ON knowledge.documents (filename, source, COALESCE(user_id, ''), chunk_ordinal);

-- 2. Verify it is valid (INVALID index is useless — see note above on retrying
-- CREATE ... IF NOT EXISTS blindly after a failed build).
SELECT indexname, indisvalid
FROM pg_indexes pi
JOIN pg_class c ON c.relname = pi.indexname
JOIN pg_index pgi ON pgi.indexrelid = c.oid
WHERE pi.schemaname = 'knowledge'
  AND pi.tablename = 'documents'
  AND pi.indexname = 'idx_documents_fn_src_uid_ord';

-- 3. Immediately after step 4 (code deploy) confirms live: drop the old index.
-- Verified against live prod (persona DB, knowledge schema, 2026-08-29): the
-- actual unique index is named ux_documents_user_source_filename, not
-- idx_documents_fn_src_uid as migration 008's own files assume — the repo's
-- migration history has drifted from what's actually deployed. Same columns
-- (filename, source, COALESCE(user_id, '')), confirmed via pg_indexes.
-- DROP INDEX CONCURRENTLY IF EXISTS knowledge.ux_documents_user_source_filename;
