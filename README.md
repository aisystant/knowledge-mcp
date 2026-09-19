# knowledge-mcp

## Offline retrieval evaluation (WP-579 Ф2)

The evaluator compares two **recorded** runs against a frozen, human-labeled
corpus. It does not call an LLM, collect queries, write to the database, or deploy
a search configuration. Query logging, a real dataset, judge execution, and the
human calibration are still prerequisites for completing Ф2.

```sh
npm run eval:retrieval -- compare /path/to/experiment.json
npm run eval:retrieval -- annotate /path/to/experiment.json > /path/to/blind-labeling.json
npm run eval:retrieval -- annotation-key /path/to/experiment.json > /path/to/private-key.json
```

Keep the decoding key away from annotators and judges. `annotate` exports the
development questions with actual generated answers and their retrieved context;
preferences and rater identity are initially null. Run the judge on both A/B
orders and normalize preferences back to `baseline`, `candidate`, or `tie` before
importing them. Humans must judge evidence support **and completeness**, not style.

### Input contract

`EvaluationInput` in `src/retrieval-evaluation.ts` is the versioned contract.
Unknown or malformed measurements fail validation; missing observations are
never silently replaced by favorable scores. Use an absolute input path outside
the repository for datasets containing private material.

| Field | Content |
| --- | --- |
| `version`, `kind`, `experiment` | `1`, `experiment` or `fixture`, unique experiment ID |
| `preregisteredAt` | ISO timestamp with timezone, before both runs |
| `policy` | Frozen minimum recall gain, maximum precision/answer losses (fractions), context character budget, exact config keys allowed to change |
| `documents` | `{id, text, sha256}`; SHA-256 of UTF-8 text is verified |
| `queries` | Unique `{id, text, stratum, split, origin, annotator, evidence}` |
| `evidence` | Minimal answer-bearing `{id, document, start, end}` spans, independent of chunk IDs |
| `baseline`, `candidate` | `{id, completedAt, config, rankings, responses}` |
| `rankings` | Query ID → ordered `{id, document, start, end}[]`; every registered query must exist, including empty rankings |
| `responses` | Query ID → exact generated answer; missing responses cannot be assessed or used for calibration |
| `judge` | Pinned `{model, promptSha256}`; the same judge/rubric for calibration and test |
| `calibration` | Development-only `{queryId, humanRater, human, judgeAB, judgeBA}`; normalized preferences, each query once |
| `answers` | Test-only `{queryId, baseline, candidate}` claim assessments |
| Claim assessment | `{start, end, supported, citations}`; ranges cover the whole generated answer without omitted non-whitespace text; citations are source spans |

Strata: `identifier`, `concept`, `procedure`, `hard`. Splits: `development`, `test`.
Origins: `wp443`, `platform_log`, `synthetic`. Config values are finite numbers,
strings or booleans. Record pinned model revisions, prompt hashes, chunker,
reranker, generation settings, and context serialization settings in config;
only the preregistered keys may differ between arms. All sources come from the
same corpus snapshot. Repeated chunk IDs must denote the same source span.

Offsets are half-open **UTF-16 character offsets**, as in JavaScript `slice`.
They must not split surrogate pairs. The current budget is the sum of retrieved
span lengths, in UTF-16 characters, **not tokens**. Context is the rank-ordered
prefix that fits the common budget; the first oversized hit ends the prefix.
Overlapping chunks consume budget individually, as they would in serialized
context. This offline protocol does not yet model added headers or parent
expansion: runners must reproduce this context contract. Token-budget and actual
production-response evaluation are future integrations, not claims of this tool.

### Metrics and decision

* **Evidence recall@10:** proportion of labeled spans fully covered by the union
  of the first ten selected hits. Partial coverage receives no recall credit.
* **Evidence precision@5:** the first five **raw ranked** chunks containing at
  least one complete evidence span, divided by five even when fewer results were
  returned. Unlike recall/coverage this secondary ranking metric is measured
  before budget-based context packing. This is
  an explicit span-based proxy, not historical WP-443 human relevance precision.
* **Coverage@10:** average fraction of each span covered, with overlaps counted once.
* Paired difference intervals: 10,000 bootstrap resamples of queries within each
  stratum, seed 42, percentile 95% interval. These assume independently sampled
  queries; topic duplicates require human deduplication beyond string matching.
* Judge calibration: at least 50 distinct development queries, Cohen's κ ≥ .75
  independently in both orders, and order disagreement ≤ .10. Degenerate κ
  (one constant category) does not pass. Development queries never enter the
  comparison; at least 200 held-out real test queries across all four strata are
  required, in addition to the calibration set.
* Answer barrier: per-query supported-claim fraction and reference evidence
  fully covered by the **union** of supported claims' citations, macro-averaged.
  Adjacent citations may jointly support an evidence span; a single all-covering
  citation is not required. Both candidate scores must be ≥ .85, with
  no loss larger than the preregistered allowance. A claimed supporting citation
  outside the actual selected top-ten context does not count. Semantic entailment
  comes from the calibrated external judge, not from substring matching here.

The practical gain must meet `minimumRecallGain`, its interval must exclude zero,
and the lower precision-difference bound must respect `maximumPrecisionLoss`.
Policy values must be recorded independently before executing the experiment.
The JSON timestamps, rater IDs and provenance labels are declarations, **not
authentication**; a reviewer must inspect the original ratings and registration.
Fixture/synthetic inputs can never pass the evidence gate, regardless of size.

`compare` emits JSON and exits:

* `0`: `candidate_for_review` — evidence is ready for an independent decision;
  it grants no deployment permission.
* `1`: `insufficient_evidence`, `answer_barrier_failed`, or `no_practical_gain`.
  A confidence interval including zero means inconclusive, not equivalence.
* `2`: malformed input or invocation.

CI runs evaluator regression tests and its TypeScript check on pull requests.
This is a **contract test**, not a real-corpus quality gate: connecting reviewed
recorded runs to a mandatory pre-merge quality check remains part of Ф2.

---

## SOTA: GraphRAG + Knowledge Graphs (DP.SOTA.004)

> knowledge-mcp = retrieval layer. Цель: vector + graph traversal для multi-hop reasoning.

- Текущее: pgvector для semantic search по summary
- Следующий шаг: graph traversal по typed `related:` полям из frontmatter
- pack_search = semantic view, pack_graph = graph view, pack_get = full entity view
- При индексации: извлекать typed `related:` для построения графа связей

## Retrieval observations (opt-in, WP-579)

The public `search` path can record **the actual returned ranking**, full indexed
content SHA-256 computed in the same database query, retrieved/returned excerpt
hashes, truncation and optional citation feedback. A content hash is a version
check, not a retained corpus: evaluation still needs a frozen source snapshot and
human-reviewed evidence spans. `availableCount` is the post-rerank result count,
not all matching database rows. Missing version metadata stays `null`.

Collection is **off by default**. No production migration or collection is implied
by installing this code. The current personal-search backend is unchanged: it
does not return chunk IDs, and dedicated text-storage/sharing consent is not yet
implemented. The event builder and database both prohibit personal raw text.

Configuration for a controlled public-corpus pilot:

| Binding | Required behavior |
| --- | --- |
| `RETRIEVAL_OBSERVATION_MODE` | `hash` or `platform-text`; any other value disables collection |
| `RETRIEVAL_OBSERVATION_DATABASE_URL` | Separate non-owner, NOSUPERUSER, NOBYPASSRLS role; no membership in table-owner role |
| `RETRIEVAL_OBSERVATION_ACCOUNTS` | Explicit comma-separated verified JWT subjects; no wildcard/default collection |
| `RETRIEVAL_OBSERVATION_HMAC_KEY` | Secret of at least 32 characters; account-bound NFC+trim query fingerprints; protect and rotate as a secret |
| `RETRIEVAL_OBSERVATION_TEXT_DAYS` | Explicit integer 1–180; absent/invalid means hash-only; choose the approved period before enabling text |

Public-corpus queries can contain personal information. A conservative filter
rejects credential/PII patterns and oversized text before persistence; it cannot
detect every name or disclosure in prose. Stored rows remain **personal,
pseudonymous records**, including after query text expires. Hash-only does not
mean anonymous. Neither query text, credentials nor database error details are
written to application logs. The account comes only from verified JWT auth;
`x-user-id`, tool arguments, and anonymous requests cannot opt into collection.

Apply `migrations/023-retrieval-observations.sql` explicitly to the intended
PostgreSQL >=15 database using a migration owner. It creates a dedicated
`retrieval` schema with forced RLS. Grant the runtime role only the privileges
listed at the top of the migration. Writes fail closed if that role can bypass
RLS or inherit the owner. Per-operation pools and transaction-local identity
prevent cross-request account reuse. The narrow `SECURITY DEFINER` expiry
function is owned by the migration role, has a fixed search path, cannot return
rows, and has no PUBLIC execute grant.

Every existing cron tick scrubs up to 5,000 expired query texts, even with
collection disabled (keep the database binding until cleanup is complete).
The export view independently hides expired text if cron is delayed. Before
production: verify privileges on the real runtime role, TLS/storage and backup
retention, cron execution and capacity, operator access, approved text lifetime,
and the preliminary privacy assessment. The code implements the mechanism;
these deployment conditions are not certified by unit tests. Disabling the mode
stops new observations; it does not erase earlier unexpired records.

Search responses include `observation_id` on each hit and in result `_meta`.
This means **scheduled**, not durably written: `waitUntil` persistence is best
effort and does not block search. Driver operations have 2s timeouts, no retries.
Existing `feedback` accepts optional `observation_id` and independent `cited`
boolean (`null` when unknown). It validates that the exact hit belonged to the
caller's snapshot, never guesses by query hash. Missing rows (including the
write/feedback race) return `recorded:false` with a retry reason. Older feedback
without an observation ID keeps its existing unbound behavior and is not
silently promoted into citation evidence.

For the authenticated owner's local curation, provide `ORY_URL`,
`RETRIEVAL_EXPORT_JWT`, and the least-privilege observation DSN through the
environment, then run `npm run export:retrieval -- <private-output.json>`.
The exporter verifies the JWT itself, selects only that subject's unexpired
public-corpus text, deduplicates fingerprints (latest snapshot), caps at 1,000,
and creates a new mode-0600 file without overwriting an existing file. It prints
only the count. Do not commit this personal output to the source repository or
send it to an external judge without the separate data-sharing assessment.
It is an **unlabelled candidate pool**, not a ≥200-query calibrated test set.

Verification: unit/HTTP tests cover auth spoofing, admission, filtering, snapshot
provenance, feedback races and contained storage failure. CI also applies the
migration to disposable PostgreSQL and runs
`scripts/check-retrieval-observation-rls.sql` for account isolation, composite
feedback ownership, connection reuse and physical expiry. This remains an
infrastructure check, not a measured retrieval-quality improvement.
