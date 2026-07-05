-- Ingestion pipeline: chunks (parent-retrieval), a content hash for change
-- detection, and the ingest queue.

-- Change-detection key on the indexed document.
ALTER TABLE documents ADD COLUMN content_hash TEXT;

-- Chunks of a document (parent-retrieval): a chunk hit returns its parent doc.
-- The vector index is added with vector search (later) to avoid an empty-index cost.
CREATE TABLE document_chunks (
  id          BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position    INT NOT NULL,
  content     TEXT NOT NULL,
  embedding   vector(1024)
);
CREATE INDEX idx_chunks_document ON document_chunks(document_id);

-- The ingest queue. Dedup identity is (collection, filename); at most one PENDING
-- job per file (a processing/done job does not block a fresh pending one).
CREATE TABLE ingest_jobs (
  id           BIGSERIAL PRIMARY KEY,
  collection   TEXT NOT NULL,
  owner        TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT '',
  source_type  TEXT NOT NULL DEFAULT '',
  filename     TEXT NOT NULL,
  content      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  attempts     INT NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_ingest_pending_identity
  ON ingest_jobs(collection, filename) WHERE status = 'pending';
CREATE INDEX idx_ingest_status ON ingest_jobs(status);
