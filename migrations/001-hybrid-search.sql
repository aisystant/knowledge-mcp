-- Migration 001: Add hybrid search (pg_trgm + tsvector FTS)
-- Run: psql $DATABASE_URL -f migrations/001-hybrid-search.sql
-- Context: РП #34, DP.D.024

-- 1. Enable pg_trgm (Neon supports out of the box)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Add tsvector column
ALTER TABLE documents ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- 3. Populate from existing content
UPDATE documents SET search_vector = to_tsvector('simple', content)
WHERE search_vector IS NULL;

-- 4. Create GIN indexes
CREATE INDEX IF NOT EXISTS idx_documents_fts
  ON documents USING gin(search_vector);

CREATE INDEX IF NOT EXISTS idx_documents_trgm
  ON documents USING gin(content gin_trgm_ops);
