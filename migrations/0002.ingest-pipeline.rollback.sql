DROP TABLE IF EXISTS ingest_jobs;
DROP TABLE IF EXISTS document_chunks;
ALTER TABLE documents DROP COLUMN IF EXISTS content_hash;
