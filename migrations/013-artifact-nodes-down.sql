-- WP-338 Ф2 down: revert artifact nodes extension

DROP INDEX IF EXISTS concept_graph.idx_concepts_node_type_level;
DROP INDEX IF EXISTS concept_graph.idx_edges_from_type;

ALTER TABLE concept_graph.concept_edges
DROP CONSTRAINT IF EXISTS concept_edges_edge_type_check,
ADD CONSTRAINT concept_edges_edge_type_check
CHECK (edge_type IN ('prerequisite', 'related', 'part_of', 'specializes', 'contradicts'));

ALTER TABLE concept_graph.concepts
DROP COLUMN IF EXISTS node_type;

ALTER TABLE concept_graph.concepts
DROP CONSTRAINT IF EXISTS concepts_level_check,
ADD CONSTRAINT concepts_level_check
CHECK (level IN ('zp', 'fpf', 'pack', 'guide', 'course'));
