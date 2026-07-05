# knowledge-mcp

MCP server for the shared knowledge base — hybrid search (keyword + vector + LLM
rerank) and a concept graph over our Pack methodology, guides, and DS process
docs.

**One codebase, two run modes** (chosen at startup by a launch flag):

- **Public** (default) — no auth. Serves only platform-owned (public)
  collections. Anyone can connect directly.
- **Authed** (ORY JWT) — every request must carry a valid Bearer token. The
  caller identity (JWT `sub`) unlocks the collections it owns, on top of the
  public ones.

The same server therefore covers both public and personal knowledge; there is
no separate personal server (the old `personal-knowledge-mcp` is being retired
into this one).

Runs on Python (MCP Streamable HTTP) on Google Cloud Run, backed by Cloud SQL
PostgreSQL with pgvector + pg_trgm. Query embeddings via OpenAI; JWT verification
via ORY in authed mode. (No INFRA.md yet — infra decisions are still open.)

## Access model — collections

Access is per **collection**. Every knowledge object — document, concept, and
artifact — belongs to exactly one collection, and a collection has exactly one
owner:

- **`platform`** — the sentinel owner for public collections (visible to
  everyone, in either mode).
- **a user id** — a personal collection, visible only to that user.

The rule enforced on **every** request (retrieval and graph traversal alike):

```
collection.owner == "platform"   OR   collection.owner == caller
```

So the public server (anonymous caller) sees only `platform`; the authed server
resolves the caller from the JWT and adds that user's own collections. There is
no group sharing — a collection is either public or one user's. The user →
collection ownership lives in a simple owner column (a many-to-many access table
is deliberately out of scope for now).

### `source` is not `collection`

`source` / `source_type` (`pack` / `guides` / `ds` / `content`) are an
**orthogonal** axis — provenance and a **search filter**, not access. A personal
DS-vault and a platform Pack are both just `source`s; what gates them is their
collection owner. Keep the two apart: `source` answers "where is this from",
`collection` answers "who may see it".

## Tools

### Retrieval
| Tool | Purpose |
|------|---------|
| `search` | Hybrid search over the corpus: entity codes → keyword path, natural language → vector + LLM rerank, with parent-chunk enrichment. Filterable by `source` / `source_type`. |
| `get_document` | A document in full, or just its heading outline (`format=headings`), by filename. |
| `list_sources` | Sources with their document counts. |
| `list_documents` | Files within a source. |

### Concept graph
The graph is a heterogeneous set of nodes discriminated by `node_type`
(`concept` | `artifact`) with typed edges. It mirrors the production tool shape.

| Tool | Purpose |
|------|---------|
| `concept_status` | Status of a concept (active / deprecated / superseded) with `superseded_by`, and the misconception flag. |
| `concept_search_by_name` | Fuzzy concept lookup by name (trigram similarity). |
| `concept_expand` | BFS from **concept** seeds over concept edges (`specializes`, `part_of`, `related`, `prerequisite`, `contradicts`). |
| `pack_traverse` | BFS from **artifact** seeds over pack edges (`pack_cites`, `pack_depends_on`, `pack_extends`, `pack_implements`) and the `artifact_defines_concept` bridge into concepts. |

> A single merged `graph_traverse` (one typed-BFS over the whole heterogeneous
> graph, enabling cross-type / reverse traversal) is a possible future
> consolidation of `concept_expand` + `pack_traverse`. We track the production
> shape for now.

## Not in this server (and why)

- **Per-user / learner tools** — `analyze_verbalization`, `learner_progress`,
  learner concept mastery, per-user `feedback`. These move to **digital-twin**;
  knowledge-mcp keeps knowledge (public + personal), not learning state.
- **Ops / analytics** — `reindex_source` (reindexing is event-driven: GitHub
  Actions on push + a Postgres queue), `graph_stats`, `feedback_stats` —
  internal endpoints, not Guide-facing tools.
- **`load_skill`** — redundant with `get_document`.
- **Agent scope-grants** — the old `scope.ts` bridge/grant machinery is a
  separate authorization concern and is not part of this read model.

## Tests as contract

There is no separate contract document. The tool list above is the promise; the
tests under `tests/contract/` are the executable specification:

- `test_protocol.py` — advertised tool surface; public-by-default posture.
- `test_retrieval.py` — search / get_document / list, scoped by `source`.
- `test_access.py` — collection ownership: platform vs personal visibility.
- `test_auth.py` — the authed-mode JWT gate.
- `test_concept_graph.py` — concept status/search and graph traversal.

Tests drive the server through the real MCP transport and seed data through a
test-only seam (`knowledge_mcp.contract_testing`), never touching the storage
schema directly.
