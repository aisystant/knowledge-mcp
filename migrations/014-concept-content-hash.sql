-- WP-339 Ф3: Content-hash skip для concept_graph
-- Добавляет content_hash в concept_graph.concepts для idempotent incremental updates.
-- Hash вычисляется SHA-256 от содержимого файла (как в knowledge_chunk.hash).

ALTER TABLE concept_graph.concepts
ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- Index для fast skip-lookup при heartbeat / webhook
CREATE INDEX IF NOT EXISTS idx_concepts_content_hash
  ON concept_graph.concepts (source_repo, source_doc, content_hash)
  WHERE node_type = 'artifact';

COMMENT ON COLUMN concept_graph.concepts.content_hash IS
  'SHA-256 hash of file content at time of last ingest. Used for skip-if-unchanged in incremental pipeline. WP-339.';
