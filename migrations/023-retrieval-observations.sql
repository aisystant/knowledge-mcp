-- Apply explicitly to the observation database, never automatically on Worker startup.
-- Deploy with a separate non-owner / NOSUPERUSER / NOBYPASSRLS runtime role.
-- Grant that role USAGE on retrieval; SELECT,INSERT on observation;
-- SELECT,INSERT,UPDATE on citation_feedback; SELECT on observation_export;
-- EXECUTE on expire_text(). Do not grant membership in the migration-owner role.
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
    AND text_expires_at > observed_at AND text_expires_at <= observed_at + interval '4320 hours'))
);
CREATE INDEX observation_expiring ON retrieval.observation(text_expires_at) WHERE query_text IS NOT NULL;
CREATE INDEX observation_by_account_time ON retrieval.observation(account_id, observed_at DESC);
ALTER TABLE retrieval.observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE retrieval.observation FORCE ROW LEVEL SECURITY;
CREATE POLICY observation_account ON retrieval.observation
  USING (account_id = nullif(current_setting('app.account_id', true), ''))
  WITH CHECK (account_id = nullif(current_setting('app.account_id', true), ''));
-- Only the migration owner, not the runtime, may perform global expiry maintenance.
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
  USING (account_id = nullif(current_setting('app.account_id', true), ''))
  WITH CHECK (account_id = nullif(current_setting('app.account_id', true), ''));

-- PostgreSQL >=15: invoker RLS applies; delayed cron never exposes expired text to exports.
CREATE VIEW retrieval.observation_export WITH (security_invoker = true) AS
SELECT account_id,id,mode,observed_at,query_fingerprint,fingerprint_version,
  CASE WHEN text_expires_at > now() THEN query_text ELSE NULL END AS query_text,
  text_expires_at,text_disposition,worker_version,snapshot
FROM retrieval.observation;

CREATE FUNCTION retrieval.expire_text() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE scrubbed integer;
BEGIN
  WITH expired AS (
    SELECT account_id,id FROM retrieval.observation
    WHERE query_text IS NOT NULL AND text_expires_at <= now()
    ORDER BY text_expires_at LIMIT 5000 FOR UPDATE SKIP LOCKED
  )
  UPDATE retrieval.observation o SET query_text = NULL, text_disposition = 'expired'
  FROM expired e WHERE o.account_id=e.account_id AND o.id=e.id;
  GET DIAGNOSTICS scrubbed = ROW_COUNT;
  RETURN scrubbed;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA retrieval FROM PUBLIC;
REVOKE ALL ON FUNCTION retrieval.expire_text() FROM PUBLIC;
COMMIT;
