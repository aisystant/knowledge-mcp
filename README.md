# knowledge-mcp

**Public, read-only** MCP server for the shared knowledge base — hybrid search
(keyword + vector + LLM rerank) and a concept graph over our public Pack methodology,
guides, and DS process docs.

There is **no authentication**: anyone can connect this server directly. The gateway
fronts it with auth for its aggregated view, but the server itself serves only public
data and never touches per-user data.

Runs on Python (MCP Streamable HTTP) on Google Cloud Run, backed by Cloud SQL
PostgreSQL with pgvector + pg_trgm. (No INFRA.md yet — infra decisions are still open.)

## Access

Public, read-only. No auth, no per-user data, no subscription. (Per-user learner tools
are NOT here — see "Not in this server" below.)

## Tools

### Retrieval
| Tool | Purpose |
|------|---------|
| `search` | Hybrid search over the corpus: entity codes → keyword path, natural language → vector + LLM rerank, with parent-chunk enrichment. |
| `get_document` | A document in full, or just its heading outline, by filename. |
| `list_sources` | Sources with their document counts. |
| `list_documents` | Files within a source. |

### Concept graph
| Tool | Purpose |
|------|---------|
| `concept_status` | Status of a concept (active / deprecated / superseded) and misconception flags. |
| `concept_search_by_name` | Fuzzy concept lookup by name (trigram similarity). |
| `graph_traverse` | Breadth-first traversal over the concept graph from seed concepts or artifacts, by edge type and depth. Replaces the legacy `concept_expand` + `pack_traverse`. |

## Not in this server (and why)

- **Per-user / learner tools** — `analyze_verbalization`, `learner_progress`, and
  per-user `feedback` need authentication and per-user writes, so they cannot live in a
  public server. They belong to an authed "learner mastery" home (digital-twin / a
  dedicated learner service — still to decide). See `../OPEN-QUESTIONS.md`.
- **Ops / analytics** — `reindex_source` (reindexing is event-driven: GitHub Actions on
  push + a Postgres queue), `graph_stats`, `feedback_stats` — internal endpoints, not
  Guide-facing tools.
- **`load_skill`** — redundant with `get_document`.

## Tests as contract

There is no separate contract document. The tool list above is the promise; the tests
under `tests/` are the executable specification (I/O shape, search relevance, graph
traversal). Search-heavy tools need a seeded corpus — the test-seeding strategy is
decided before those tests are written.
