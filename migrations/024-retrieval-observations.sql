-- Apply explicitly to the observation database, never automatically on Worker startup.
-- Deploy with a separate non-owner / NOSUPERUSER / NOBYPASSRLS runtime role.
-- Grant that role USAGE on retrieval; SELECT,INSERT on observation;
-- SELECT,INSERT,UPDATE on citation_feedback; SELECT on observation_export;
-- EXECUTE on expire_observations(). Do not grant membership in the migration-owner role.
-- A separate monitor role gets only USAGE on retrieval and EXECUTE on maintenance_status().
BEGIN;
CREATE SCHEMA retrieval;
REVOKE ALL ON SCHEMA retrieval FROM PUBLIC;

CREATE TABLE retrieval.observation (
  account_id text NOT NULL,
  id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('public','private')),
  observed_at timestamptz NOT NULL,
  query_fingerprint text NOT NULL CHECK (query_fingerprint ~ '^[0-9a-f]{64}$'),
  fingerprint_version text NOT NULL DEFAULT 'hmac-sha256:nfc-trim-v1',
  query_text text,
  text_expires_at timestamptz,
  text_disposition text NOT NULL CHECK (text_disposition IN ('disabled','private','filtered','retained','expired')),
  worker_version text,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot->'hits') = 'array'),
  PRIMARY KEY (account_id,id),
  CHECK (mode <> 'private' OR query_text IS NULL),
  CHECK (query_text IS NULL OR (text_disposition = 'retained'
    AND char_length(query_text) BETWEEN 1 AND 4000 AND text_expires_at IS NOT NULL
    AND text_expires_at > observed_at AND text_expires_at <= observed_at + interval '2160 hours'))
);
CREATE INDEX observation_expiring ON retrieval.observation(text_expires_at) WHERE query_text IS NOT NULL;
CREATE INDEX observation_record_expiring ON retrieval.observation(observed_at);
CREATE INDEX observation_by_account_time ON retrieval.observation(account_id, observed_at DESC);
ALTER TABLE retrieval.observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE retrieval.observation FORCE ROW LEVEL SECURITY;
CREATE POLICY observation_account ON retrieval.observation
  USING (account_id = nullif(current_setting('app.account_id', true), '')
    AND observed_at > statement_timestamp() - interval '2160 hours')
  WITH CHECK (account_id = nullif(current_setting('app.account_id', true), '')
    AND observed_at > statement_timestamp() - interval '2160 hours'
    AND observed_at <= statement_timestamp() + interval '5 minutes');
-- Only the migration owner, not the runtime, may perform global expiry maintenance.
-- CURRENT_USER is resolved to that role at policy creation, not on each request.
CREATE POLICY observation_maintenance ON retrieval.observation TO CURRENT_USER USING (true) WITH CHECK (true);

CREATE TABLE retrieval.citation_feedback (
  account_id text NOT NULL,
  observation_id uuid NOT NULL,
  document_id bigint NOT NULL,
  helpfulness boolean NOT NULL,
  cited boolean,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id,observation_id,document_id),
  FOREIGN KEY (account_id,observation_id) REFERENCES retrieval.observation(account_id,id) ON DELETE CASCADE
);
ALTER TABLE retrieval.citation_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE retrieval.citation_feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY feedback_account ON retrieval.citation_feedback
  USING (account_id = nullif(current_setting('app.account_id', true), '')
    AND EXISTS (SELECT 1 FROM retrieval.observation o
      WHERE o.account_id = citation_feedback.account_id AND o.id = citation_feedback.observation_id))
  WITH CHECK (account_id = nullif(current_setting('app.account_id', true), '')
    AND EXISTS (SELECT 1 FROM retrieval.observation o
      WHERE o.account_id = citation_feedback.account_id AND o.id = citation_feedback.observation_id));

-- PostgreSQL >=15: invoker RLS applies; delayed cron never exposes expired text to exports.
CREATE VIEW retrieval.observation_export WITH (security_invoker = true) AS
SELECT account_id,id,mode,observed_at,query_fingerprint,fingerprint_version,
  CASE WHEN text_expires_at > statement_timestamp() THEN query_text ELSE NULL END AS query_text,
  text_expires_at,text_disposition,worker_version,snapshot,
  LEAST(text_expires_at, observed_at + interval '2160 hours') AS expires_at
FROM retrieval.observation;

-- One replaceable operational state, not an unbounded event or query history.
-- Only the migration owner / definer may mutate it. Never grant runtime table access.
CREATE TABLE retrieval.maintenance_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_success_at timestamptz NOT NULL,
  processed_count integer NOT NULL CHECK (processed_count >= 0)
);

CREATE FUNCTION retrieval.expire_observations() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE scrubbed integer;
DECLARE deleted integer;
BEGIN
  -- Full removal includes identifiers/fingerprints/snapshots; FK cascades feedback.
  -- Timestamp stays anchored to the original observation, never feedback/export time.
  WITH expired_records AS (
    SELECT account_id,id FROM retrieval.observation
    WHERE observed_at <= statement_timestamp() - interval '2160 hours'
    ORDER BY observed_at LIMIT 5000 FOR UPDATE SKIP LOCKED
  )
  DELETE FROM retrieval.observation o USING expired_records e
  WHERE o.account_id=e.account_id AND o.id=e.id;
  GET DIAGNOSTICS deleted = ROW_COUNT;

  -- Optional shorter raw-text window, while the remaining record is still live.
  WITH expired AS (
    SELECT account_id,id FROM retrieval.observation
    WHERE query_text IS NOT NULL AND text_expires_at <= statement_timestamp()
    ORDER BY text_expires_at LIMIT 5000 FOR UPDATE SKIP LOCKED
  )
  UPDATE retrieval.observation o SET query_text = NULL, text_disposition = 'expired'
  FROM expired e WHERE o.account_id=e.account_id AND o.id=e.id;
  GET DIAGNOSTICS scrubbed = ROW_COUNT;
  -- Commit/rollback of the heartbeat is atomic with actual cleanup, including
  -- failures after this function returns but before the caller commits.
  INSERT INTO retrieval.maintenance_state(singleton,last_success_at,processed_count)
  VALUES (true, clock_timestamp(), deleted + scrubbed)
  ON CONFLICT (singleton) DO UPDATE
    SET last_success_at = clock_timestamp(), processed_count = EXCLUDED.processed_count;
  RETURN deleted + scrubbed;
END $$;

-- Narrow cross-account operational inspection. Calling as an ordinary role must
-- not produce a falsely empty backlog because of account-scoped RLS.
CREATE FUNCTION retrieval.maintenance_status()
RETURNS TABLE(last_success_at timestamptz, seconds_since_success double precision,
  expired_records bigint, expired_texts bigint, oldest_overdue_seconds double precision,
  alarm boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH backlog AS (
    SELECT count(*) FILTER (WHERE observed_at <= statement_timestamp() - interval '2160 hours') AS records,
      count(*) FILTER (WHERE query_text IS NOT NULL AND text_expires_at <= statement_timestamp()) AS texts,
      greatest(0, extract(epoch FROM statement_timestamp() - least(
        min(observed_at + interval '2160 hours'),
        min(text_expires_at) FILTER (WHERE query_text IS NOT NULL)
      )))::double precision AS overdue
    FROM retrieval.observation
  )
  SELECT s.last_success_at, extract(epoch FROM statement_timestamp() - s.last_success_at)::double precision,
    b.records, b.texts, b.overdue,
    (s.last_success_at IS NULL OR s.last_success_at <= statement_timestamp() - interval '30 minutes'
      OR s.last_success_at > statement_timestamp() + interval '1 minute'
      OR b.records > 0 OR b.texts > 0)
  FROM backlog b LEFT JOIN retrieval.maintenance_state s ON s.singleton
$$;
REVOKE ALL ON ALL TABLES IN SCHEMA retrieval FROM PUBLIC;
REVOKE ALL ON FUNCTION retrieval.expire_observations() FROM PUBLIC;
REVOKE ALL ON FUNCTION retrieval.maintenance_status() FROM PUBLIC;
COMMIT;
