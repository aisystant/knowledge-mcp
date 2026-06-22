-- WP-242 Ф-C: Glossary export view for translate.py (WP-415)
-- Creates concept_graph.concept_glossary_export — bilingual pack terminology.
-- ADR: WP-242 provides view, WP-415 owns format contract.
-- Only bilingual pack concepts (name_ru AND name_en both non-null).
-- Ref: peer-session-2026-06-22-04 consensus.

CREATE OR REPLACE VIEW concept_graph.concept_glossary_export AS
SELECT
  code,
  name_ru,
  name_en,
  definition,
  domain,
  status
FROM concept_graph.concepts
WHERE status = 'active'
  AND level = 'pack'
  AND node_type = 'concept'
  AND name_ru IS NOT NULL
  AND name_en IS NOT NULL
ORDER BY domain NULLS LAST, code;

COMMENT ON VIEW concept_graph.concept_glossary_export IS
  'Bilingual pack terminology for translate.py (WP-415). '
  'Only active pack concepts with both name_ru and name_en. '
  'WP-242 owns the data; WP-415 owns the format contract. '
  'Backfill expansion (remaining ~210 partial concepts) pending WP-242 Ф-B.';
