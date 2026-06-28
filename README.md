# knowledge-mcp

Autonomous MCP server for the **shared platform knowledge base** — hybrid search
(keyword + vector + LLM rerank) and a concept graph over the Pack methodology, guides,
and DS process docs. Platform content is visible to every authenticated user
(`account_id = NULL`); any per-user content is isolated by `account_id`.

Runs on Python (MCP Streamable HTTP) on Google Cloud Run, backed by Cloud SQL
PostgreSQL with pgvector + pg_trgm. (No INFRA.md yet — infra decisions are still open.)

## Auth

Every `tools/call` requires a valid Ory JWT (Hydra JWKS, RS256). Identity is the `sub`
claim; there is no `x-user-id` fallback. Platform knowledge is **free for authenticated
users** (no subscription required); per-user content is filtered by `account_id`.

## Tools

### Retrieval
| Tool | Purpose |
|------|---------|
| `search` | Hybrid search over the corpus: entity codes → keyword path, natural language → vector + LLM rerank, with parent-chunk enrichment. |
| `get_document` | A document in full, or just its heading outline, by filename. |
| `list_sources` | Sources with their document counts. |
| `list_documents` | Files within a source. |
| `load_skill` | Load a `SKILL.md` from the exocortex template. |

### Concept graph
| Tool | Purpose |
|------|---------|
| `concept_status` | Status of a concept (active / deprecated / superseded) and misconception flags. |
| `concept_search_by_name` | Fuzzy concept lookup by name (trigram similarity). |
| `concept_expand` | Breadth-first traversal over semantic edges from one or more concepts. |
| `pack_traverse` | Breadth-first traversal from artifact nodes over pack edges. |

### Learner
| Tool | Purpose |
|------|---------|
| `analyze_verbalization` | LLM-as-judge: which concepts of a topic a learner's text covers; updates mastery. |
| `learner_progress` | A learner's concept-mastery progress, by domain. |

> ⚠ `analyze_verbalization` and `learner_progress` must derive the learner identity from
> the **JWT `sub`**, not from a tool argument (the TS originals took `user_id` as an
> argument — a cross-user read/write hole). See `../OPEN-QUESTIONS.md`.

### Feedback
| Tool | Purpose |
|------|---------|
| `feedback` | Record a helpful / not-helpful signal on a retrieved document. |
| `feedback_stats` | Aggregated feedback over the last N days. |

### Under review (likely ops / analytics, not Guide-facing MCP tools)
| Tool | Why under review |
|------|------------------|
| `reindex_source` | In the new design reindexing is event-driven (GitHub Actions on push) + a Postgres queue, so this is likely an internal/ops endpoint, not an authenticated Guide tool. The TS MCP tool was also unauthenticated. |
| `graph_stats` | Graph-wide statistics (counts, orphans, suspicious edges) — observability; keep as a tool only if the Guide actually needs it. |

## Tests as contract

There is no separate contract document. The tool list above is the promise; the tests
under `tests/` are the executable specification (I/O shape, auth gating, per-user
isolation). The implementation must pass them. Search-heavy tools need a seeded corpus —
the test-seeding strategy is decided before those tests are written.
