-- WP-242 Ф8.4 — откат

DROP TRIGGER IF EXISTS trg_concepts_touch_updated_at ON concept_graph.concepts;
DROP FUNCTION IF EXISTS concept_graph.touch_concept_updated_at();

DROP TABLE IF EXISTS health.graph_usage_events;
DROP SCHEMA IF EXISTS health CASCADE;

DROP INDEX IF EXISTS concept_graph.idx_edges_last_traversed;
ALTER TABLE concept_graph.concept_edges DROP COLUMN IF EXISTS last_traversed_at;

ALTER TABLE concept_graph.concepts DROP CONSTRAINT IF EXISTS concepts_status_check;
ALTER TABLE concept_graph.concepts
  ADD CONSTRAINT concepts_status_check
  CHECK (status IN ('active', 'deprecated', 'draft'));

DROP INDEX IF EXISTS concept_graph.idx_concepts_active;
ALTER TABLE concept_graph.concepts DROP COLUMN IF EXISTS misconception;
ALTER TABLE concept_graph.concepts DROP COLUMN IF EXISTS superseded_by;
