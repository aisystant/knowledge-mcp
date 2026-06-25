-- WP-439 Ф2: KIND-context views for translation + drop unused 'inherited' source.
--
-- WHY: a specializes-edge to a U.* root is TYPING ("X is a Method"), not synonymy.
-- Probe on prod: U.Method has 420 children, U.Episteme 235, U.ServiceClause 137.
-- Inheriting the parent's exact name_en would collapse 420 distinct concepts to the
-- name "Method" — that destroys names, not fills them. So Ф2 does NOT write name_en;
-- it exposes the parent's name_en as a TYPE HINT that Ф3 feeds into the translation
-- prompt. Name population stays in Ф3.
-- Ref: peer-session 2026-06-25-10.

BEGIN;

-- (1) Drop the unused 'inherited' value from the name_en_source CHECK.
--     Ф1 never set it and Ф2 abandons name inheritance, so it is dead.
--     Guard: fail loudly if any row somehow carries it (must be 0).
DO $$
DECLARE
  cname text;
BEGIN
  IF EXISTS (SELECT 1 FROM concept_graph.concepts WHERE name_en_source = 'inherited') THEN
    RAISE EXCEPTION 'rows with name_en_source=inherited exist — refusing to drop it from CHECK';
  END IF;
  -- Find the existing CHECK constraint by definition (inline-column name is auto-generated).
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'concept_graph.concepts'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%name_en_source%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE concept_graph.concepts DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE concept_graph.concepts
  ADD CONSTRAINT concepts_name_en_source_check
  CHECK (name_en_source IN ('fpf', 'glossary', 'llm', 'manual', 'unknown'));

-- (2) KIND-context view: normalized input for Ф3 translation. One row per
--     (child, name_en-bearing specializes-parent). parent_name_en is the child's
--     KIND (e.g. "Method"), fed into the glossary-prompt as context — NOT copied
--     into the child's name_en.
CREATE OR REPLACE VIEW concept_graph.concept_kind_context AS
SELECT
  c.id              AS child_id,
  c.code            AS child_code,
  c.name            AS child_name,
  c.name_ru         AS child_name_ru,
  c.name_en         AS child_name_en,
  c.name_en_source  AS child_name_en_source,
  c.level           AS child_level,
  c.domain          AS child_domain,
  p.code            AS parent_code,
  p.name_en         AS parent_name_en,
  p.level           AS parent_level
FROM concept_graph.concepts c
JOIN concept_graph.concept_edges e
  ON e.from_concept_id = c.id AND e.edge_type = 'specializes'
JOIN concept_graph.concepts p
  ON p.id = e.to_concept_id
WHERE c.status = 'active'
  AND p.name_en IS NOT NULL;

COMMENT ON VIEW concept_graph.concept_kind_context IS
  'WP-439 Ф2: type hints for Ф3 translation. child specializes parent; parent_name_en '
  'is the KIND of the child (e.g. "Method"), NOT a name to inherit. Ф3 feeds parent_name_en '
  'into the glossary-prompt as context. Ref peer-session 2026-06-25-10.';

-- (3) Translation orphans: active concepts with no name_en AND no name_en-bearing
--     specializes-parent. Ф3 translates these without a type hint / manual review.
CREATE OR REPLACE VIEW concept_graph.concept_translation_orphans AS
SELECT c.id, c.code, c.name, c.name_ru, c.level, c.domain
FROM concept_graph.concepts c
WHERE c.status = 'active'
  AND c.name_en IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM concept_graph.concept_edges e
    JOIN concept_graph.concepts p ON p.id = e.to_concept_id
    WHERE e.from_concept_id = c.id
      AND e.edge_type = 'specializes'
      AND p.name_en IS NOT NULL
  );

COMMENT ON VIEW concept_graph.concept_translation_orphans IS
  'WP-439 Ф2: active concepts with no name_en and no name_en-bearing specializes-parent. '
  'Ф3 translates without type context. Ref peer-session 2026-06-25-10.';

COMMIT;
