-- Knowledge MCP — PostgreSQL schema (Neon + pgvector)
-- Run once: psql $DATABASE_URL -f schema.sql

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
  id BIGSERIAL PRIMARY KEY,
  filename TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT '',
  hash VARCHAR(16) NOT NULL DEFAULT '',
  embedding vector(1024),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Upsert key: one document per filename+source
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_filename_source
  ON documents(filename, source);

-- Vector search (HNSW — fast approximate nearest neighbor)
CREATE INDEX IF NOT EXISTS idx_documents_embedding
  ON documents USING hnsw (embedding vector_cosine_ops);

-- Filter indexes
CREATE INDEX IF NOT EXISTS idx_documents_source_type
  ON documents(source_type);

CREATE INDEX IF NOT EXISTS idx_documents_source
  ON documents(source);
