-- Migration 007: Bilingual concept names (WP-242 Ф3)
-- Adds name_ru and name_en columns to concept_graph.concepts.
-- Strategy: variant A (two fields) from ArchGate.
-- Existing 'name' field is kept as-is (source of truth for display).
-- name_ru / name_en are populated by ingest-concepts.ts from frontmatter
-- or via Llama 4 Scout batch translation (variant D of Ф3 plan).

ALTER TABLE concept_graph.concepts
  ADD COLUMN IF NOT EXISTS name_ru TEXT,
  ADD COLUMN IF NOT EXISTS name_en TEXT;

-- Trigram indexes for multilingual search
CREATE INDEX IF NOT EXISTS idx_concepts_name_ru_trgm ON concept_graph.concepts USING gin (name_ru gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_concepts_name_en_trgm ON concept_graph.concepts USING gin (name_en gin_trgm_ops);

-- Backfill: for concepts where name is clearly English (ascii-only, no Cyrillic),
-- copy name → name_en. For concepts with Cyrillic, copy name → name_ru.
-- This is a heuristic — manual review / LLM pass will fill the gaps.
UPDATE concept_graph.concepts
  SET name_en = name
  WHERE name ~ '^[[:ascii:]]+$' AND name_en IS NULL;

UPDATE concept_graph.concepts
  SET name_ru = name
  WHERE name ~ '[А-Яа-яЁё]' AND name_ru IS NULL;

COMMENT ON COLUMN concept_graph.concepts.name_ru IS 'Russian name (Wikidata label pattern). Populated by ingest or LLM batch.';
COMMENT ON COLUMN concept_graph.concepts.name_en IS 'English name. Populated by ingest or LLM batch.';
