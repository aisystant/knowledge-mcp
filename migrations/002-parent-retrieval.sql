-- Migration 002: Parent Document Retrieval
-- Adds parent_id column to link chunks to their full parent document.
-- Parent documents are stored without embeddings (too large for meaningful vectors).
-- Chunks point to parent via parent_id; search returns parent content when available.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES documents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_documents_parent_id ON documents(parent_id);
