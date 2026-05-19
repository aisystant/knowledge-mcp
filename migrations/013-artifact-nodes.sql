-- WP-338 Ф2: Artifact nodes — расширение concept_graph для Pack-файлов
-- Добавляет node_type + level='artifact' для дискриминации документов vs понятий
-- Новые edge_types для связей между artifact-узлами и concept

-- ============================================================
-- 1. Расширить level CHECK — добавить 'artifact'
-- ============================================================

ALTER TABLE concept_graph.concepts
DROP CONSTRAINT IF EXISTS concepts_level_check;

ALTER TABLE concept_graph.concepts
ADD CONSTRAINT concepts_level_check
CHECK (level IN ('zp', 'fpf', 'pack', 'guide', 'course', 'artifact'));

-- ============================================================
-- 2. Добавить node_type для явной дискриминации (ArchGate mitigation)
-- ============================================================

ALTER TABLE concept_graph.concepts
ADD COLUMN IF NOT EXISTS node_type TEXT NOT NULL DEFAULT 'concept'
CHECK (node_type IN ('concept', 'artifact'));

COMMENT ON COLUMN concept_graph.concepts.node_type IS
  'Node type: concept (knowledge entity) or artifact (document/file). WP-338 ArchGate mitigation for mixed graph traversal.';

-- ============================================================
-- 3. Новые типы рёбер для artifact-связей
-- ============================================================

ALTER TABLE concept_graph.concept_edges
DROP CONSTRAINT IF EXISTS concept_edges_edge_type_check;

ALTER TABLE concept_graph.concept_edges
ADD CONSTRAINT concept_edges_edge_type_check
CHECK (edge_type IN (
  'prerequisite', 'related', 'part_of', 'specializes', 'contradicts',
  'pack_cites', 'pack_depends_on', 'pack_contradicts', 'pack_extends', 'pack_implements',
  'artifact_defines_concept'
));

-- ============================================================
-- 4. Составной индекс для BFS с фильтром по edge_type (ArchGate performance)
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_edges_from_type
  ON concept_graph.concept_edges (from_concept_id, edge_type);

COMMENT ON INDEX concept_graph.idx_edges_from_type IS
  'Composite index for artifact graph traversal with type filtering. WP-338 ArchGate performance mitigation.';

-- ============================================================
-- 5. Индекс для node_type + level (фильтрация mixed-graph запросов)
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_concepts_node_type_level
  ON concept_graph.concepts (node_type, level)
  WHERE node_type = 'concept';

COMMENT ON INDEX concept_graph.idx_concepts_node_type_level IS
  'Partial index for pure-concept queries (excludes artifacts). WP-338.';
