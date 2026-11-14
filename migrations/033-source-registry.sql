-- WP-604 Э1: empty source/access registry. No backfill and no runtime grants.

CREATE TABLE knowledge.sources (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_key TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('github', 'other')),
  repository_id BIGINT,
  github_owner TEXT,
  github_repo TEXT,
  region TEXT NOT NULL CHECK (btrim(region) <> ''),
  steward_account_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sources_github_identity_check CHECK (
    (source_kind = 'github' AND repository_id IS NOT NULL
      AND github_owner IS NOT NULL AND github_repo IS NOT NULL)
    OR
    (source_kind = 'other' AND repository_id IS NULL
      AND github_owner IS NULL AND github_repo IS NULL)
  )
);

CREATE UNIQUE INDEX sources_region_key_unique
  ON knowledge.sources (region, source_key);
CREATE UNIQUE INDEX sources_region_repository_unique
  ON knowledge.sources (region, repository_id)
  WHERE repository_id IS NOT NULL;

CREATE TABLE knowledge.source_access_grants (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES knowledge.sources(id) ON DELETE RESTRICT,
  subject_account_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('owner', 'github_right', 'publisher_grant', 'platform_open')),
  required_mode TEXT NOT NULL CHECK (required_mode IN ('none', 'account', 'subscription')),
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'suspended', 'blocked', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT source_access_subject_check CHECK (
    (kind = 'platform_open' AND subject_account_id IS NULL AND required_mode = 'none')
    OR
    (kind <> 'platform_open' AND subject_account_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX source_access_named_subject_unique
  ON knowledge.source_access_grants (source_id, subject_account_id, kind)
  WHERE subject_account_id IS NOT NULL;
CREATE UNIQUE INDEX source_access_public_subject_unique
  ON knowledge.source_access_grants (source_id, kind)
  WHERE subject_account_id IS NULL;

CREATE TABLE knowledge.source_access_decisions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  grant_id BIGINT NOT NULL REFERENCES knowledge.source_access_grants(id) ON DELETE RESTRICT,
  actor_account_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
  from_state TEXT CHECK (from_state IN ('active', 'suspended', 'blocked', 'revoked')),
  to_state TEXT NOT NULL CHECK (to_state IN ('active', 'suspended', 'blocked', 'revoked')),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT source_access_decision_transition_check CHECK (
    from_state IS NULL OR from_state <> to_state
  )
);

CREATE FUNCTION knowledge.reject_source_access_decision_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'source_access_decisions is append-only';
END;
$$;

CREATE TRIGGER source_access_decisions_no_update
  BEFORE UPDATE ON knowledge.source_access_decisions
  FOR EACH ROW EXECUTE FUNCTION knowledge.reject_source_access_decision_mutation();
CREATE TRIGGER source_access_decisions_no_delete
  BEFORE DELETE ON knowledge.source_access_decisions
  FOR EACH ROW EXECUTE FUNCTION knowledge.reject_source_access_decision_mutation();
CREATE TRIGGER source_access_decisions_no_truncate
  BEFORE TRUNCATE ON knowledge.source_access_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION knowledge.reject_source_access_decision_mutation();
