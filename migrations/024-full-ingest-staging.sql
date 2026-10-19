-- 024: Batched full-ingest for oversized platform documents (WP-532 Ф9)
--
-- syncFullIngestSource() (migration 015 context) chunks and embeds a document
-- sequentially, one chunk at a time, deleting the old chunks first. For a document
-- the size of FPF-Spec.md (~1500 chunks) that risks leaving the document's search
-- rows in a genuinely incomplete state if the run doesn't finish. This migration adds
-- the two tables a batched, resumable, atomically-swapped version needs:
--
--   full_ingest_runs      — one row per full-ingest attempt of one document. The
--                            partial unique index below is the actual single-writer
--                            enforcement (DB-level, not application discipline) — a
--                            second concurrent run for the same document simply
--                            cannot insert a 'running' row.
--   knowledge_chunk_staging — chunks land here, batch by batch, invisible to search
--                            (a different table, not a flag on knowledge_chunk — a
--                            flag would need every search query path to filter on
--                            it, a broader change against code every source relies
--                            on). Moved into knowledge_chunk only once every chunk is
--                            confirmed present, via the CAS pattern the consumer code
--                            implements against full_ingest_runs.status.
--
-- Apply: psql "$KNOWLEDGE_DIRECT" -v ON_ERROR_STOP=1 -f migrations/024-full-ingest-staging.sql

BEGIN;

CREATE TABLE IF NOT EXISTS full_ingest_runs (
  run_id          TEXT PRIMARY KEY,
  source          TEXT NOT NULL,
  document_path   TEXT NOT NULL,
  source_revision TEXT NOT NULL,  -- GitHub blob SHA pinned before batching starts
  total_chunks    INT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'swapping', 'swapped', 'abandoned')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  swapped_at      TIMESTAMPTZ
);

-- The actual single-writer guarantee: a second INSERT for the same (source,
-- document_path) while one run is still 'running' violates this index and fails,
-- not a race an application-level check could lose.
CREATE UNIQUE INDEX IF NOT EXISTS uq_running_ingest_per_doc
  ON full_ingest_runs (source, document_path)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_full_ingest_runs_created_at
  ON full_ingest_runs (created_at)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS knowledge_chunk_staging (
  staging_id        BIGSERIAL PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES full_ingest_runs (run_id) ON DELETE CASCADE,
  chunk_index       INT NOT NULL CHECK (chunk_index >= 0),
  role              TEXT NOT NULL CHECK (role IN ('parent', 'child')),
  -- knowledge_chunk.chunk_uuid is PK DEFAULT gen_random_uuid() — fine for a single-row
  -- insert, but the final swap moves parent+children in one INSERT...SELECT, and a
  -- child row's parent_chunk_id must point at ITS PARENT'S uuid. A value only Postgres
  -- assigns at that same INSERT can't be read back into a sibling row of the same
  -- statement. Generating both uuids client-side before staging (and carrying them
  -- through) sidesteps the self-reference instead of a second UPDATE pass after insert.
  chunk_uuid        UUID NOT NULL,
  parent_chunk_uuid  UUID,  -- NULL for role='parent'; the parent's own chunk_uuid for role='child'
  chunk_id          TEXT NOT NULL,
  document_path     TEXT NOT NULL,
  paragraph_pos     INT NOT NULL,
  content_hash      TEXT NOT NULL,
  source_uri        TEXT NOT NULL,
  content           TEXT NOT NULL,
  source            TEXT NOT NULL,
  source_kind       TEXT,
  hash              CHAR(16) NOT NULL,
  embedding         vector(1024),  -- NULL for the parent row, matching knowledge_chunk's own large-file convention
  collection_kind   TEXT NOT NULL DEFAULT 'platform',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_kcs_run_id ON knowledge_chunk_staging (run_id);

COMMENT ON TABLE full_ingest_runs IS
  'WP-532 Ф9: one row per batched full-ingest attempt. status=running is the DB-enforced single-writer claim (uq_running_ingest_per_doc); swapping is the CAS state a consumer holds while performing the atomic cutover; abandoned = source changed mid-run or run exceeded its TTL, cleaned up by the next scheduled sweep.';
COMMENT ON TABLE knowledge_chunk_staging IS
  'WP-532 Ф9: draft chunks for an in-progress full-ingest run, invisible to search (separate table, not a flag on knowledge_chunk). Moved into knowledge_chunk in one transaction once every chunk_index for the run is present.';

COMMIT;
