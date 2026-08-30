-- 021: Persistent per-file indexing status (WP-7 Ф97.2)
--
-- Context: Ф97.1 made personal_write/reindex responses honestly async
-- ("indexing: {status: async}"), Ф98 made partial batch failures visible to
-- the operator (ops alert), but neither gives the USER a way to check whether
-- a specific file has actually finished indexing. This table closes that gap.
--
-- Peer-session 2026-08-30-18 (Claude+Kimi+Codex) design decisions:
-- * Separate table, not columns on `documents` — documents is chunk-granular
--   (one row per chunk, N rows per file), so a per-file status column there
--   would need N redundant writes and an ambiguous source of truth.
-- * Two-value status ('indexed'|'error'), no 'pending' — absence of a row
--   already means "not indexed / unknown", avoiding an orphan-state enum
--   value nothing is responsible for clearing.
-- * user_id is TEXT (matches documents.user_id / reindex_jobs.user_id — an
--   Ory identity string, not a UUID; caught by Codex code review).
-- * content_hash is diagnostic only (detects stale status vs. current file
--   version) — it does NOT resolve concurrent-push ordering (R1/R2); a full
--   fix needs a commit-SHA/version token from the webhook, deferred as a
--   follow-up, not part of this phase.
-- * No RLS — follows the reindex_jobs precedent (migration 009), which is
--   also per-user but has no RLS: both are only ever read/written through
--   application code with an explicit user_id filter, never exposed to raw
--   SQL access the way `documents` is. Security Gate rationale (ArchGate
--   profile, WP-410 precedent, Cloudflare Workers RLS operational risk
--   #231) is recorded once in DS-my-strategy/inbox/WP-7/DRR-f97-2-personal-db-no-rls.md
--   — future personal-DB migrations should cite it, not re-derive it.

CREATE TABLE IF NOT EXISTS knowledge.file_index_status (
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  filename TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('indexed', 'error')),
  indexed_at TIMESTAMPTZ,
  last_index_error TEXT,
  content_hash VARCHAR(16),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, source, filename)
);
