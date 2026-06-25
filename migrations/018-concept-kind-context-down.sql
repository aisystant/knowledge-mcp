-- WP-439 Ф2 rollback: drop the two views and restore 'inherited' in the CHECK.

BEGIN;

DROP VIEW IF EXISTS concept_graph.concept_translation_orphans;
DROP VIEW IF EXISTS concept_graph.concept_kind_context;

-- Restore the 017 value set (with 'inherited').
DO $$
DECLARE
  cname text;
BEGIN
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
  CHECK (name_en_source IN ('fpf', 'glossary', 'inherited', 'llm', 'manual', 'unknown'));

COMMIT;
