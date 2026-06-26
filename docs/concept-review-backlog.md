# Concept Graph — Translation Review Backlog

> WP-439. Current pending review queue.
> Process: [concept-graph-process.md](concept-graph-process.md).
> Last updated: 2026-06-26 (Ф3 completion).

## Status snapshot (2026-06-26)

| Metric | Value |
|--------|-------|
| Total active concepts | 3947 |
| Translatable (is_translatable=TRUE) | ~3610 est. |
| With name_en | 3319 (~84%) |
| Pending review (status=pending) | 1024 |
| — of which: LLM-generated | 446 |
| — of which: manual / code-free | 578 |
| is_translatable=FALSE | ~337 est. (numeric codes, acronyms) |

## Batch review assignments

Translations with `status=pending` need human review to verify accuracy.
Priority: domain-specific terms where LLM may have chosen the wrong register.

### Query: current pending LLM translations (by domain)

```sql
SELECT domain, COUNT(*) AS pending_count
FROM concept_graph.concepts
WHERE status = 'active'
  AND is_translatable = TRUE
  AND name_en IS NOT NULL
  AND name_en_status = 'pending'
GROUP BY domain
ORDER BY pending_count DESC;
```

### Query: spot-check 10 random pending translations

```sql
SELECT code, name_ru, name_en, name_en_source
FROM concept_graph.concepts
WHERE status = 'active' AND name_en_status = 'pending'
ORDER BY RANDOM()
LIMIT 10;
```

### Bulk approve all pending (after manual spot-check confirms quality)

```sql
-- Run this only after sampling confirms >90% accuracy.
UPDATE concept_graph.concepts
SET name_en_status = 'ok'
WHERE status = 'active' AND name_en_status = 'pending';
```

### Correct a specific translation

```sql
UPDATE concept_graph.concepts
SET name_en = 'Corrected English Name',
    name_en_source = 'manual',
    name_en_status = 'ok'
WHERE code = 'DP.METHOD.049';
```

## Remaining untranslated concepts (~628)

These have `name_en IS NULL AND is_translatable = TRUE`. To fill via LLM batch:

```bash
cd ~/IWE/DS-MCP/knowledge-mcp
python3 scripts/wp439-apply-translations.py --bulk --limit 100
```

After each batch run, re-check coverage:

```bash
npx tsx scripts/check-graph-health.ts --update
```

## Glossary gaps

When spot-checking reveals a term the glossary should cover but doesn't:

1. Add the entry to `data/glossary-v0.1.csv` (format: `term_ru,term_en,context,notes`).
2. Regenerate the embedded TS constant: `npx tsx scripts/build-glossary-anchor.ts` (to be created).
3. Re-ingest affected concepts or run `apply-translations.py` to pick up the new anchor.

For now (v0.1), the glossary has 127 core IWE/MIM domain terms.
