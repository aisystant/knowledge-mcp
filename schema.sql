-- Knowledge MCP — PostgreSQL schema (Neon + pgvector + hybrid search)
-- Run once: psql $DATABASE_URL -f schema.sql

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS documents (
  id BIGSERIAL PRIMARY KEY,
  filename TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT '',
  hash VARCHAR(16) NOT NULL DEFAULT '',
  embedding vector(1024),
  search_vector tsvector,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Upsert key: one document per filename+source
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_filename_source
  ON documents(filename, source);

-- Vector search (HNSW — fast approximate nearest neighbor)
CREATE INDEX IF NOT EXISTS idx_documents_embedding
  ON documents USING hnsw (embedding vector_cosine_ops);

-- Keyword search: full-text search (tsvector + GIN)
CREATE INDEX IF NOT EXISTS idx_documents_fts
  ON documents USING gin(search_vector);

-- Keyword search: fuzzy/substring match (pg_trgm + GIN)
CREATE INDEX IF NOT EXISTS idx_documents_trgm
  ON documents USING gin(content gin_trgm_ops);

-- Filter indexes
CREATE INDEX IF NOT EXISTS idx_documents_source_type
  ON documents(source_type);

CREATE INDEX IF NOT EXISTS idx_documents_source
  ON documents(source);
