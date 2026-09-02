-- 022: Source fingerprint + index state (WP-560 Ф3)
--
-- Context: connectSource (both personal-knowledge-mcp/src/index.ts — live path for
-- personal_connect_source — and the private-mode port knowledge-mcp/src/layers/personal.ts)
-- keys user_sources only by (user_id, source name). Reconnecting a GitHub App installation
-- under a source name previously bound to a different physical repository silently keeps
-- serving the old repository's documents (Valery-Iwe incident, WP-527 Ф7; root-caused and
-- consensus-reviewed by Kimi+Codex, peer-session 2026-09-02-12-wp560-f3-f5-implementation).
--
-- github_repository_id is GitHub's immutable numeric repo id (survives rename/owner-transfer;
-- github_owner/github_repo in this same table do not). index_state/index_generation give the
-- read path a fail-closed signal while a fingerprint-mismatch purge+reindex is in flight, and
-- let the reindex queue consumer discard writes from a job whose generation has been superseded
-- (fencing) — required per round-1/round-3 consensus with codex (security-and-migration-reviewer).
--
-- Apply against the shared `knowledge` schema (same DB backs personal-knowledge-mcp and
-- knowledge-mcp). Nullable/defaulted columns — no backfill needed, legacy rows are handled by
-- the application-level "NULL fingerprint + existing documents => fail-closed purge" branch on
-- next connect, not by this migration.

ALTER TABLE knowledge.user_sources
  ADD COLUMN IF NOT EXISTS github_repository_id BIGINT;

ALTER TABLE knowledge.user_sources
  ADD COLUMN IF NOT EXISTS index_state TEXT NOT NULL DEFAULT 'ready'
    CHECK (index_state IN ('ready', 'reindexing', 'failed'));

ALTER TABLE knowledge.user_sources
  ADD COLUMN IF NOT EXISTS index_generation INTEGER NOT NULL DEFAULT 1;

-- Read path (personal_search / personal_list_path) must require BOTH active=true AND
-- index_state='ready' — a source mid-purge-and-reindex must not serve stale-or-partial
-- results. This index supports that combined predicate.
CREATE INDEX IF NOT EXISTS idx_user_sources_active_ready
  ON knowledge.user_sources (user_id, source)
  WHERE active = true AND index_state = 'ready';

-- Fencing token carried by each reindex job — a queue consumer must compare this against
-- the CURRENT knowledge.user_sources.index_generation for (user_id, source) before writing
-- any document, and discard (not retry) the batch if they differ (superseded job).
ALTER TABLE knowledge.reindex_jobs
  ADD COLUMN IF NOT EXISTS generation INTEGER;
