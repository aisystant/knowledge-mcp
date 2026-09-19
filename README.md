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
