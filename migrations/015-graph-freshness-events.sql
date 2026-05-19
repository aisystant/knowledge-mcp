-- 015: Graph freshness events — heartbeat observability (WP-339 Ф6)
--
-- Records one row per (source, heartbeat_run): drift=github_count - db_count,
-- p99 staleness, whether a reindex was triggered. Used by Metabase dashboard
-- and ad-hoc drift queries.
--
-- Depends on: health schema (migration 011).

CREATE TABLE IF NOT EXISTS health.graph_freshness_events (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL,
  github_count INT NOT NULL,
  db_count INT NOT NULL,
  drift INT NOT NULL GENERATED ALWAYS AS (github_count - db_count) STORED,
  reindexed BOOLEAN NOT NULL DEFAULT FALSE,
  reindex_processed INT,
  reindex_skipped INT,
  p99_staleness_hours REAL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_freshness_source_created
  ON health.graph_freshness_events (source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_freshness_created
  ON health.graph_freshness_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_freshness_drift
  ON health.graph_freshness_events (drift, created_at DESC)
  WHERE ABS(drift) > 5;

COMMENT ON TABLE health.graph_freshness_events IS
  'One row per heartbeat per Pack source. Tracks drift (github_count - db_count) and p99 staleness. WP-339 Ф6.';
