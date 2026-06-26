-- WP-439 Ф6: is_translatable flag + coverage_baseline ratchet table.
--
-- WHY is_translatable: numeric codes (e.g. "3D-моделирование"), version strings
-- ("HTTP/2"), and standard acronyms have established EN equivalents that ingest
-- already populates from FPF/glossary. A blanket mask (`~ '^[0-9]'`) produces
-- false negatives on real terms like "OAuth 2.0" or "ISO 27001". Explicit flag
-- lets operators override ingest heuristics without touching the mask logic.
-- Backfill at migration time uses the mask as an *approximation*; operators can
-- correct individual rows with a plain UPDATE.
--
-- WHY coverage_baseline in DB: file-based `.coverage-baseline.json` requires a
-- manual PR after every CI run that moves coverage — causing merge conflicts in
-- parallel branches. A single-row DB table is updated transactionally by CI and
-- never conflicts. The ratchet check is: current_coverage >= baseline; CI updates
-- baseline when coverage improves.
-- Ref: peer-session 2026-06-26-06.

BEGIN;

-- (1) Add is_translatable column (default TRUE, NOT NULL).
ALTER TABLE concept_graph.concepts
  ADD COLUMN IF NOT EXISTS is_translatable BOOLEAN NOT NULL DEFAULT TRUE;

-- (2) Backfill: set is_translatable=FALSE for concepts that are numeric codes,
--     path-like strings, or technical version identifiers. This is an approximation;
--     operators can correct individual rows with a plain UPDATE.
--     UPDATE and GET DIAGNOSTICS are in the same DO block so ROW_COUNT is accurate.
DO $$
DECLARE
  updated int;
BEGIN
  UPDATE concept_graph.concepts SET is_translatable = FALSE
  WHERE status = 'active'
    AND name_en IS NULL
    AND is_translatable = TRUE
    AND (
      name_ru ~ '^[0-9]'           -- starts with digit: "3D-...", "2D-..."
      OR name_ru ~ '^\d+[.]'       -- version-like: "1.0", "2.1.3"
      OR (name_ru LIKE '%/%' AND name_ru NOT LIKE '% /%' AND name_ru NOT LIKE '%/ %')
    );
  GET DIAGNOSTICS updated = ROW_COUNT;
  RAISE NOTICE 'is_translatable backfill: % rows set to FALSE', updated;
END $$;

-- (3) Create coverage_baseline table (single-row ratchet).
CREATE TABLE IF NOT EXISTS concept_graph.coverage_baseline (
  id                  BIGINT PRIMARY KEY DEFAULT 1,      -- singleton row
  pct_with_en         NUMERIC(5,2) NOT NULL,             -- e.g. 84.30
  total_active        INT NOT NULL,                       -- snapshot total at measurement
  total_translatable  INT NOT NULL,                       -- active WHERE is_translatable=TRUE
  translatable_with_en INT NOT NULL,                     -- translatable AND name_en IS NOT NULL
  measured_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by          TEXT NOT NULL DEFAULT 'manual',    -- 'ci' | 'manual'
  CONSTRAINT coverage_singleton CHECK (id = 1)
);

COMMENT ON TABLE concept_graph.coverage_baseline IS
  'WP-439 Ф6: single-row ratchet for coverage CI check. CI fails when '
  'pct_with_en drops below this baseline. Updated transactionally by '
  'scripts/check-graph-health.ts when coverage improves. '
  'Ref: peer-session 2026-06-26-06.';

-- (4) Seed the baseline with the current measured value (84% from Ф3 probe).
INSERT INTO concept_graph.coverage_baseline
  (id, pct_with_en, total_active, total_translatable, translatable_with_en, updated_by)
SELECT
  1,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE name_en IS NOT NULL AND is_translatable = TRUE)
    / NULLIF(COUNT(*) FILTER (WHERE is_translatable = TRUE), 0),
    2
  ),
  COUNT(*) FILTER (WHERE status = 'active'),
  COUNT(*) FILTER (WHERE status = 'active' AND is_translatable = TRUE),
  COUNT(*) FILTER (WHERE status = 'active' AND is_translatable = TRUE AND name_en IS NOT NULL)
FROM concept_graph.concepts
WHERE status = 'active'
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  baseline NUMERIC(5,2);
BEGIN
  SELECT pct_with_en INTO baseline FROM concept_graph.coverage_baseline WHERE id = 1;
  RAISE NOTICE 'coverage_baseline seeded: %% coverage', baseline;
END $$;

COMMIT;
