-- 004: Multi-user GitHub onboarding (WP-187 Ф4.0)
--
-- 1. Add user_id to documents (NULL = platform/L2, non-NULL = personal/L4)
-- 2. Create github_installations table (Ory user → GitHub installation mapping)
-- 3. Create user_sources table (per-user personal sources, replaces hardcoded PERSONAL_SOURCES)
-- 4. Backfill existing personal documents with Tseren's user_id
--
-- Run: psql $DATABASE_URL -f migrations/004-user-github-onboarding.sql

-- Step 1: user_id column on documents
ALTER TABLE documents ADD COLUMN IF NOT EXISTS user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_documents_user_id
  ON documents(user_id);

-- Composite index for personal queries: user_id + source
CREATE INDEX IF NOT EXISTS idx_documents_user_source
  ON documents(user_id, source);

-- Step 2: GitHub installations mapping
CREATE TABLE IF NOT EXISTS github_installations (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,                    -- Ory identity ID
  github_user_id BIGINT NOT NULL,           -- GitHub numeric user ID (immutable)
  github_username TEXT NOT NULL,            -- GitHub login (display only, may change)
  installation_id BIGINT NOT NULL,          -- GitHub App installation ID
  repos JSONB NOT NULL DEFAULT '[]',        -- Array of repo names ["DS-my-strategy", ...]
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, github_user_id)
);

CREATE INDEX IF NOT EXISTS idx_github_installations_user
  ON github_installations(user_id);

CREATE INDEX IF NOT EXISTS idx_github_installations_github_user
  ON github_installations(github_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_github_installations_install_id
  ON github_installations(installation_id);

-- Step 3: Per-user personal sources (dynamic replacement for hardcoded PERSONAL_SOURCES)
CREATE TABLE IF NOT EXISTS user_sources (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,                    -- Ory identity ID
  source TEXT NOT NULL,                     -- Repo name (e.g. "DS-my-strategy")
  github_owner TEXT NOT NULL,               -- GitHub owner (e.g. "TserenTserenov")
  github_repo TEXT NOT NULL,                -- GitHub repo name
  path_prefix TEXT NOT NULL DEFAULT '',     -- Path prefix within repo
  source_type TEXT NOT NULL DEFAULT 'ds',   -- Document type tag
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, source)
);

CREATE INDEX IF NOT EXISTS idx_user_sources_user
  ON user_sources(user_id);

-- Step 4: Backfill — assign existing personal documents to Tseren
UPDATE documents SET user_id = '25d91dbb-6ea2-46a7-a3da-cc1fd9dc9340'
  WHERE source IN ('DS-Knowledge-Index-Tseren', 'DS-my-strategy', 'DS-creator-development', 'DS-marathon-v2-tseren', 'DS-agent-workspace')
    AND user_id IS NULL;

-- Backfill user_sources for Tseren
INSERT INTO user_sources (user_id, source, github_owner, github_repo) VALUES
  ('25d91dbb-6ea2-46a7-a3da-cc1fd9dc9340', 'DS-Knowledge-Index-Tseren', 'TserenTserenov', 'DS-Knowledge-Index-Tseren'),
  ('25d91dbb-6ea2-46a7-a3da-cc1fd9dc9340', 'DS-my-strategy', 'TserenTserenov', 'DS-my-strategy'),
  ('25d91dbb-6ea2-46a7-a3da-cc1fd9dc9340', 'DS-creator-development', 'TserenTserenov', 'DS-creator-development'),
  ('25d91dbb-6ea2-46a7-a3da-cc1fd9dc9340', 'DS-marathon-v2-tseren', 'TserenTserenov', 'DS-marathon-v2-tseren'),
  ('25d91dbb-6ea2-46a7-a3da-cc1fd9dc9340', 'DS-agent-workspace', 'TserenTserenov', 'DS-agent-workspace')
ON CONFLICT (user_id, source) DO NOTHING;
