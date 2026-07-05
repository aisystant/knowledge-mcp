-- Initial schema: collections (access), documents (corpus), concepts +
-- concept_edges (heterogeneous graph). See src/knowledge_mcp/db.py for how it is read.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Access unit. Exactly one owner per collection; 'platform' is the public owner.
CREATE TABLE collections (
  id     BIGSERIAL PRIMARY KEY,
  name   TEXT UNIQUE NOT NULL,
  owner  TEXT NOT NULL
);

-- Retrieval corpus. source/source_type are provenance (search filter),
-- orthogonal to access, which is governed by the owning collection.
CREATE TABLE documents (
  id            BIGSERIAL PRIMARY KEY,
  collection_id BIGINT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT '',
  source_type   TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL,
  embedding     vector(1024),
  UNIQUE (collection_id, filename)
);
CREATE INDEX idx_documents_collection ON documents(collection_id);
CREATE INDEX idx_documents_source ON documents(source);
CREATE INDEX idx_documents_content_trgm ON documents USING gin (content gin_trgm_ops);

-- Graph nodes: concepts AND artifacts, discriminated by node_type.
CREATE TABLE concepts (
  id            BIGSERIAL PRIMARY KEY,
  collection_id BIGINT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  node_type     TEXT NOT NULL DEFAULT 'concept',
  status        TEXT NOT NULL DEFAULT 'active',
  superseded_by TEXT,
  misconception BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (collection_id, code)
);
CREATE INDEX idx_concepts_collection ON concepts(collection_id);
CREATE INDEX idx_concepts_name_trgm ON concepts USING gin (name gin_trgm_ops);

CREATE TABLE concept_edges (
  id            BIGSERIAL PRIMARY KEY,
  collection_id BIGINT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  from_code     TEXT NOT NULL,
  to_code       TEXT NOT NULL,
  edge_type     TEXT NOT NULL
);
CREATE INDEX idx_edges_collection_from ON concept_edges(collection_id, from_code, edge_type);
