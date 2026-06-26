-- WP-439 Ф6: rollback 019
BEGIN;
DROP TABLE IF EXISTS concept_graph.coverage_baseline;
ALTER TABLE concept_graph.concepts DROP COLUMN IF EXISTS is_translatable;
COMMIT;
