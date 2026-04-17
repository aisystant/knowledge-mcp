-- 009: Reindex jobs + auto_reindex opt-out (WP-187 Ф-K.1)
--
-- Context: expose `personal_reindex_source` as an MCP tool so users can trigger
-- reindex of their connected repos ("переиндексируй мой PACK"). Because CF Worker
-- timeouts cap at ~30s, large repos (>200 files) must run async: tool returns
-- job_id immediately, `personal_reindex_status` polls progress. Table backs that.
--
-- ArchGate decisions (Q1=b waitUntil+poll, Q2=hash-dedup+cooldown, Q3=pk-mcp owns).
-- L2.5 mitigation: per-source `auto_reindex_enabled` — cheap opt-out hook for later.

-- gen_random_uuid() is built-in in PostgreSQL 13+, but pgcrypto extension is a safe fallback.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Step 1: reindex_jobs — async job tracking for /reindex-full
CREATE TABLE IF NOT EXISTS knowledge.reindex_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,                           -- Ory identity ID (owner of the job)
  source TEXT NOT NULL,                            -- source name (e.g. "DS-my-strategy")
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  processed INT NOT NULL DEFAULT 0,                -- files successfully (re)indexed
  skipped INT NOT NULL DEFAULT 0,                  -- files skipped (hash match, non-md, too large)
  deleted INT NOT NULL DEFAULT 0,                  -- files deleted (removed from repo)
  total INT,                                       -- total files to process (known after Trees API scan)
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,       -- array of error strings
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

-- Cooldown check: SELECT ... WHERE user_id=? AND source=? ORDER BY started_at DESC LIMIT 1
CREATE INDEX IF NOT EXISTS idx_reindex_jobs_user_source_started
  ON knowledge.reindex_jobs (user_id, source, started_at DESC);

-- Status polling: SELECT ... WHERE id=?
-- (primary key covers it — no extra index needed)

-- Step 2: opt-out for auto-reindex (Ф-K.2 OAuth auto-index hook)
ALTER TABLE knowledge.user_sources
  ADD COLUMN IF NOT EXISTS auto_reindex_enabled BOOLEAN NOT NULL DEFAULT true;
