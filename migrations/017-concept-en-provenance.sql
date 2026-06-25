-- WP-439 Ф1: name_en provenance + review status for the concept graph.
-- Adds two columns to concept_graph.concepts:
--   name_en_source  — where the English name came from
--   name_en_status  — review-queue state for that English name
-- Then backfills provenance for names already present in the graph:
--   (1) root U.* concepts carry canonical EN from FPF Part A (seeded by
--       scripts/ingest-concepts.ts uConcepts array) -> 'fpf';
--   (2) every other prior name_en is of UNESTABLISHED origin (frontmatter
--       meta.name_en, migration 007 ASCII heuristic, or a past LLM run) ->
--       'unknown' + 'flagged'. We deliberately do NOT label these 'llm':
--       that would assert an origin we cannot prove (WP-439 Ф3 audit, risk 1).
--
-- The glossary anchor (iwe-translation-engine/glossary/glossary-v0.1.csv) is
-- applied separately by scripts/wp439-apply-anchor.ts — a CSV in another repo
-- cannot be read from SQL, and glossary is RP-415's source-of-truth (no copy
-- into a local anchor table; provenance is denormalized onto concepts).
--
-- Ownership: WP-439 owns concept name_en population; WP-242 owns graph
-- structure; WP-415 owns the glossary source-of-truth.
-- Ref: peer-session 2026-06-25-08 (consensus: denormalized provenance, no anchor table).

BEGIN;

ALTER TABLE concept_graph.concepts
  ADD COLUMN IF NOT EXISTS name_en_source TEXT
    CHECK (name_en_source IN ('fpf', 'glossary', 'inherited', 'llm', 'manual', 'unknown'));

ALTER TABLE concept_graph.concepts
  ADD COLUMN IF NOT EXISTS name_en_status TEXT NOT NULL DEFAULT 'ok'
    CHECK (name_en_status IN ('ok', 'flagged', 'pending'));

-- (1) Root U.* concepts: canonical EN from FPF Part A (already in the graph).
UPDATE concept_graph.concepts
  SET name_en_source = 'fpf'
  WHERE code LIKE 'U.%'
    AND name_en IS NOT NULL
    AND name_en_source IS NULL;

-- (2) All other prior name_en values: origin not established -> queue for audit.
UPDATE concept_graph.concepts
  SET name_en_source = 'unknown',
      name_en_status = 'flagged'
  WHERE name_en IS NOT NULL
    AND name_en_source IS NULL;

COMMIT;
