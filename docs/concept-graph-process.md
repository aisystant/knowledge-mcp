# Concept Graph — Process for EN Name Population

> WP-439 Ф4. Describes the lifecycle of EN names in concept_graph.concepts.
> Backlog of pending reviews: see [concept-review-backlog.md](concept-review-backlog.md).

## Why EN names matter

The concept graph is queried by MCP tools across two languages. Without `name_en`,
semantic search misses EN-language queries, and concept expansion loses cross-language
links. Coverage target: ≥84% of translatable active concepts (tracked by ratchet).

## Concept lifecycle

```
ingest (name_ru populated)
  │
  ├─ glossary hit → name_en=<term>, source=glossary, status=ok
  │                 (synchronous, no LLM cost, e.g. "Метод" → "Method")
  │
  ├─ LLM translation at ingest-time (3s timeout)
  │   success → name_en=<term>, source=llm, status=pending (needs human review)
  │   timeout → name_en=NULL (falls through to batch path below)
  │
  └─ name_en=NULL → picked up by apply-translations.py --bulk
                    (batch script, run manually or on schedule)
                    → source=llm, status=pending
                          │
                          └─ human review → status=ok (or name_en corrected)
```

## is_translatable flag

Some concepts are technical identifiers that already have a stable EN form at ingest
(codes like `DP.METHOD.049`, acronyms like `RCS`, numeric identifiers like `3D-моделирование`).

- `is_translatable = FALSE` — ingest will not attempt LLM translation.
  Coverage ratchet excludes these from its denominator.
- `is_translatable = TRUE` (default) — all concepts start here; ingest tries to fill name_en.

To mark a concept non-translatable:
```sql
UPDATE concept_graph.concepts SET is_translatable = FALSE WHERE code = 'YOUR.CODE';
```

## Roles

| Role | Action |
|------|--------|
| Ingest pipeline | Populates name_en via glossary/LLM at index time |
| `wp439-apply-translations.py --bulk` | Batch-fills remaining NULL via LLM |
| Human reviewer | Approves pending translations (status: pending → ok) |
| `check-graph-health.ts` | CI ratchet — fails on coverage regression |

## Coverage ratchet (Ф6)

`concept_graph.coverage_baseline` holds a single-row baseline (pct_with_en).
CI runs `npx tsx scripts/check-graph-health.ts` on every relevant push.

- Coverage below baseline → CI fails (coverage regression).
- Coverage above baseline + `--update` flag → baseline updates transactionally.

To check coverage locally:
```bash
npx tsx scripts/check-graph-health.ts            # check only
npx tsx scripts/check-graph-health.ts --update   # check + ratchet up on improvement
```

## Batch review workflow (for human reviewer)

See [concept-review-backlog.md](concept-review-backlog.md) for the current pending list
and batch assignments.

Quick approval of a single translation:
```sql
UPDATE concept_graph.concepts
SET name_en_status = 'ok'
WHERE code = 'DP.METHOD.049' AND name_en_status = 'pending';
```

Flag as wrong and correct:
```sql
UPDATE concept_graph.concepts
SET name_en = 'Correct English Name', name_en_status = 'ok'
WHERE code = 'DP.METHOD.049';
```

After bulk review, re-run the ratchet with `--update` to record the new baseline.

## Sources

- `data/glossary-v0.1.csv` — canonical anchor terms (127 entries, from WP-415)
- `src/translation.ts` — embedded glossary map + LLM translation helper
- `scripts/wp439-apply-translations.py` — batch translation script
- `scripts/check-graph-health.ts` — CI health check
- Migration 019 — `is_translatable` column + `coverage_baseline` table
