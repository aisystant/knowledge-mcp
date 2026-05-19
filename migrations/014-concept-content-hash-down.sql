-- WP-339 Ф3 rollback

DROP INDEX IF EXISTS concept_graph.idx_concepts_content_hash;

ALTER TABLE concept_graph.concepts
DROP COLUMN IF EXISTS content_hash;
