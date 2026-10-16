-- WP-5 Ф64: user-owned GitHub App authorization for organization repositories.
-- Run against the personal knowledge database before enabling the team-repo flow.
-- Existing personal installation rows and sources are left untouched.

CREATE TABLE IF NOT EXISTS knowledge.github_user_credentials (
  user_id TEXT PRIMARY KEY,
  github_user_id BIGINT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  access_expires_at TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE knowledge.github_user_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.github_user_credentials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS github_user_credentials_owner ON knowledge.github_user_credentials;
CREATE POLICY github_user_credentials_owner ON knowledge.github_user_credentials
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

CREATE TABLE IF NOT EXISTS knowledge.github_user_repo_bindings (
  user_id TEXT NOT NULL,
  github_user_id BIGINT NOT NULL,
  repository_id BIGINT NOT NULL,
  repository_node_id TEXT NOT NULL,
  installation_id BIGINT NOT NULL,
  installation_owner_id BIGINT NOT NULL,
  github_owner TEXT NOT NULL,
  github_repo TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  generation BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, repository_id),
  FOREIGN KEY (user_id) REFERENCES knowledge.github_user_credentials(user_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS github_user_repo_bindings_installation
  ON knowledge.github_user_repo_bindings (user_id, installation_id);

-- Minimal push fan-out map. The webhook has no user identity to set for the
-- user-scoped bindings above; it can read this metadata without token access.
CREATE TABLE IF NOT EXISTS knowledge.github_team_reindex_subscriptions (
  user_id TEXT NOT NULL,
  repository_id BIGINT NOT NULL,
  installation_id BIGINT NOT NULL,
  source TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, repository_id)
);
CREATE INDEX IF NOT EXISTS github_team_reindex_subscriptions_delivery
  ON knowledge.github_team_reindex_subscriptions (installation_id, repository_id)
  WHERE active = true;

ALTER TABLE knowledge.github_user_repo_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.github_user_repo_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS github_user_repo_bindings_owner ON knowledge.github_user_repo_bindings;
CREATE POLICY github_user_repo_bindings_owner ON knowledge.github_user_repo_bindings
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

ALTER TABLE knowledge.user_sources
  ADD COLUMN IF NOT EXISTS github_user_binding_id BIGINT;

CREATE INDEX IF NOT EXISTS user_sources_github_user_binding
  ON knowledge.user_sources (user_id, github_user_binding_id)
  WHERE github_user_binding_id IS NOT NULL;
