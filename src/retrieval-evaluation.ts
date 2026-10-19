/** Offline, paired retrieval evaluation (WP-579 Ф2). No network or production writes. */
import { createHash } from "node:crypto";

export type Preference = "baseline" | "candidate" | "tie";
export type Stratum = "identifier" | "concept" | "procedure" | "hard";
export interface Span { document: string; start: number; end: number }
export interface Evidence extends Span { id: string }
export interface Hit extends Span { id: string }
export interface Query {
  id: string;
  text: string;
  stratum: Stratum;
  split: "development" | "test";
  origin: "wp443" | "platform_log" | "synthetic";
  /** Human-reviewed, minimal answer-bearing spans, in UTF-16 offsets. */
  evidence: Evidence[];
  annotator: string;
}
export interface Run {
  id: string;
  completedAt: string;
  config: Record<string, string | number | boolean>;
  rankings: Record<string, Hit[]>;
  /** Exact generated answers, kept separate from subsequent judge annotations. */
  responses: Record<string, string>;
}
export interface Calibration {
  queryId: string;
  humanRater: string;
  human: Preference;
  /** Preferences normalized back to pipeline names, NOT display positions. */
  judgeAB: Preference;
  judgeBA: Preference;
}
export interface Claim {
  /** Character range in the exact response, not a judge-written paraphrase. */
  start: number;
  end: number;
  supported: boolean;
  /** Unsupported claims may have no citation; supported claims must cite context. */
  citations: Span[];
}
export interface AnswerAssessment {
  queryId: string;
  baseline: Claim[];
  candidate: Claim[];
}
export interface EvaluationInput {
  version: 1;
  kind: "experiment" | "fixture";
  experiment: string;
  preregisteredAt: string;
  /** All limits must be frozen BEFORE producing either ranking. */
  policy: {
    minimumRecallGain: number;
    maximumPrecisionLoss: number;
    maximumAnswerLoss: number;
    contextCharacters: number;
    changedConfigKeys: string[];
  };
  documents: { id: string; text: string; sha256: string }[];
  queries: Query[];
  baseline: Run;
  candidate: Run;
  judge: { model: string; promptSha256: string };
  calibration: Calibration[];
  answers: AnswerAssessment[];
}
export interface Metrics { recall10: number; precision5: number; coverage10: number }
type PairedRow = { queryId: string; stratum: Stratum; baseline: Metrics; candidate: Metrics };
const STRATA: Stratum[] = ["identifier", "concept", "procedure", "hard"];
const PREFERENCES: Preference[] = ["baseline", "candidate", "tie"];
const SHA256 = /^[a-f0-9]{64}$/;
const MIN_QUERIES = 200;
const MIN_CALIBRATION = 50;

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid evaluation: ${message}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function unique(values: string[], label: string): void {
  requireValue(values.every(nonempty) && new Set(values).size === values.length, `${label}: empty or duplicate ID`);
}

function fraction(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function timestamp(value: unknown): number {
  requireValue(typeof value === "string" && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value), "timestamp must include timezone");
  const result = Date.parse(value);
  requireValue(Number.isFinite(result), "invalid timestamp");
  return result;
}

function span(value: unknown, documents: Map<string, string>): asserts value is Span {
  requireValue(record(value) && typeof value.document === "string", "span document missing");
  const text = documents.get(value.document);
  requireValue(text !== undefined, "span references unknown document");
  requireValue(Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end), "span offsets must be integers");
  const start = value.start as number, end = value.end as number;
  requireValue(start >= 0 && end > start && end <= text.length, "span outside source document");
  for (const offset of [start, end]) {
    requireValue(!(offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset] ?? "")), "span splits a surrogate pair");
  }
}

function validateRun(value: unknown, queries: Query[], documents: Map<string, string>, preregistration: number): asserts value is Run {
  requireValue(record(value) && nonempty(value.id) && record(value.config) && record(value.rankings) && record(value.responses), "invalid run");
  requireValue(timestamp(value.completedAt) > preregistration, "run must follow preregistration");
  requireValue(Object.keys(value.config).length > 0 && Object.values(value.config).every(v =>
    typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))), "invalid run config");
  const ids = queries.map(q => q.id).sort();
  requireValue(JSON.stringify(Object.keys(value.rankings).sort()) === JSON.stringify(ids), "both runs must contain exactly the registered queries (empty rankings allowed)");
  for (const [id, response] of Object.entries(value.responses))
    requireValue(ids.includes(id) && nonempty(response), "response requires known query and nonempty generated text");
  const chunks = new Map<string, string>();
  for (const hits of Object.values(value.rankings)) {
    requireValue(Array.isArray(hits), "ranking must be an array");
    for (const hit of hits) {
      span(hit, documents);
      requireValue(record(hit) && nonempty(hit.id), "hit ID missing");
      const definition = JSON.stringify([hit.document, hit.start, hit.end]);
      requireValue(!chunks.has(hit.id) || chunks.get(hit.id) === definition, "chunk ID changes source span within a run");
      chunks.set(hit.id, definition);
    }
    unique(hits.map(h => h.id), "ranked chunks");
    unique(hits.map(h => JSON.stringify([h.document, h.start, h.end])), "ranked spans");
  }
}

function validateClaims(claims: unknown, response: unknown, documents: Map<string, string>): void {
  requireValue(typeof response === "string" && nonempty(response), "assessment requires actual generated answer");
  requireValue(Array.isArray(claims) && claims.length > 0, "answer must have explicit claim assessments");
  let previousEnd = 0;
  for (const claim of claims) {
    requireValue(record(claim) && typeof claim.supported === "boolean" && Array.isArray(claim.citations), "invalid claim assessment");
    span({ document: "answer", start: claim.start, end: claim.end }, new Map([["answer", response]]));
    const start = claim.start as number, end = claim.end as number;
    requireValue(start >= previousEnd && response.slice(previousEnd, start).trim() === "", "claim annotations omit answer text or overlap");
    requireValue(response.slice(start, end).trim().length > 0, "empty claim");
    requireValue(!claim.supported || claim.citations.length > 0, "supported claim requires citation");
    for (const citation of claim.citations) span(citation, documents);
    previousEnd = end;
  }
  requireValue(response.slice(previousEnd).trim() === "", "claim annotations omit trailing answer text");
}

function validateJudgments(input: Record<string, unknown>, queries: Query[], documents: Map<string, string>, baseline: Run, candidate: Run): void {
  requireValue(record(input.judge) && nonempty(input.judge.model) && typeof input.judge.promptSha256 === "string" && SHA256.test(input.judge.promptSha256), "judge model and prompt hash required");
  requireValue(Array.isArray(input.calibration) && Array.isArray(input.answers), "judgments must be arrays");
  const byId = new Map(queries.map(q => [q.id, q]));
  for (const rating of input.calibration) {
    requireValue(record(rating) && typeof rating.queryId === "string" && byId.get(rating.queryId)?.split === "development", "calibration must use development queries only");
    requireValue(nonempty(rating.humanRater), "human rater required");
    requireValue(nonempty(baseline.responses[rating.queryId]) && nonempty(candidate.responses[rating.queryId]), "calibration requires both actual generated answers");
    for (const key of ["human", "judgeAB", "judgeBA"])
      requireValue(PREFERENCES.includes(rating[key] as Preference), "invalid or missing normalized preference");
  }
  unique(input.calibration.map(r => r.queryId), "calibration queries");
  for (const answer of input.answers) {
    requireValue(record(answer) && typeof answer.queryId === "string" && byId.get(answer.queryId)?.split === "test", "answer assessment must reference test query");
    validateClaims(answer.baseline, baseline.responses[answer.queryId], documents);
    validateClaims(answer.candidate, candidate.responses[answer.queryId], documents);
  }
  unique(input.answers.map(a => a.queryId), "answer queries");
}

/** Reject malformed input rather than converting missing data to perfect/zero scores. */
export function parseEvaluation(value: unknown): EvaluationInput {
  requireValue(record(value) && value.version === 1 && ["fixture", "experiment"].includes(value.kind as string) && nonempty(value.experiment), "invalid version, kind, or experiment ID");
  const preregistration = timestamp(value.preregisteredAt);
  const p = value.policy;
  requireValue(record(p) && fraction(p.minimumRecallGain) && p.minimumRecallGain > 0 && fraction(p.maximumPrecisionLoss) && fraction(p.maximumAnswerLoss), "invalid practical thresholds");
  requireValue(Number.isSafeInteger(p.contextCharacters) && (p.contextCharacters as number) > 0, "positive context budget required");
  requireValue(Array.isArray(p.changedConfigKeys) && p.changedConfigKeys.length > 0, "declare intended config differences");
  unique(p.changedConfigKeys, "changed config keys");
  requireValue(Array.isArray(value.documents) && value.documents.length > 0, "documents missing");
  for (const d of value.documents)
    requireValue(record(d) && nonempty(d.id) && nonempty(d.text) && d.sha256 === sha256(d.text), "document hash mismatch or missing document");
  unique(value.documents.map(d => d.id), "documents");
  const documents = new Map<string, string>(value.documents.map(d => [d.id, d.text]));
  requireValue(Array.isArray(value.queries) && value.queries.length > 0, "queries missing");
  for (const q of value.queries) {
    requireValue(record(q) && nonempty(q.id) && nonempty(q.text) && nonempty(q.annotator), "query requires ID, text, human annotator");
    requireValue(STRATA.includes(q.stratum as Stratum) && ["development", "test"].includes(q.split as string) && ["wp443", "platform_log", "synthetic"].includes(q.origin as string), "invalid query stratum, split, or origin");
    requireValue(Array.isArray(q.evidence) && q.evidence.length > 0, "query requires relevant evidence");
    for (const e of q.evidence) {
      span(e, documents);
      requireValue(record(e) && nonempty(e.id), "evidence ID missing");
    }
    unique(q.evidence.map(e => e.id), "evidence");
    unique(q.evidence.map(e => JSON.stringify([e.document, e.start, e.end])), "evidence spans");
  }
  const queries = value.queries as Query[];
  unique(queries.map(q => q.id), "queries");
  unique(queries.map(q => q.text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()), "normalized queries");
  validateRun(value.baseline, queries, documents, preregistration);
  validateRun(value.candidate, queries, documents, preregistration);
  const baseline = value.baseline, candidate = value.candidate;
  requireValue(baseline.id !== candidate.id, "run IDs must differ");
  const configKeys = [...new Set([...Object.keys(baseline.config), ...Object.keys(candidate.config)])];
  const changed = configKeys.filter(k => baseline.config[k] !== candidate.config[k]).sort();
  requireValue(JSON.stringify(changed) === JSON.stringify([...p.changedConfigKeys].sort()), "run config differences disagree with preregistration");
  validateJudgments(value, queries, documents, baseline, candidate);
  return value as unknown as EvaluationInput;
}

/** Coverage is a UNION: overlap and duplicate evidence never count twice. */
export function coverage(evidence: Span, hits: Span[]): number {
  const intervals = hits.filter(h => h.document === evidence.document && h.start < evidence.end && h.end > evidence.start)
    .map(h => [Math.max(h.start, evidence.start), Math.min(h.end, evidence.end)])
    .sort((a, b) => a[0] - b[0]);
  let end = evidence.start, covered = 0;
  for (const [start, stop] of intervals) {
    covered += Math.max(0, stop - Math.max(end, start));
    end = Math.max(end, stop);
  }
  return covered / (evidence.end - evidence.start);
}

/** Same explicit character budget in both arms; no silently dropping long hits. */
export function budgetedHits(hits: Hit[], budget: number): Hit[] {
  const selected: Hit[] = [];
  let used = 0;
  for (const hit of hits) {
    const size = hit.end - hit.start;
    if (used + size > budget) break;
    selected.push(hit);
    used += size;
  }
  return selected;
}

export function scoreQuery(query: Query, hits: Hit[], budget: number): Metrics {
  const selected = budgetedHits(hits, budget);
  const coverages = query.evidence.map(e => coverage(e, selected.slice(0, 10)));
  return {
    // Full coverage prevents credit for retrieving only the vicinity of an answer.
    recall10: coverages.filter(c => c === 1).length / coverages.length,
    coverage10: mean(coverages),
    // Missing ranks count as misses: returning one relevant result is NOT P@5=1.
    // Ranking precision is measured before context packing; recall/coverage use the budget.
    precision5: hits.slice(0, 5).filter(h => query.evidence.some(e => coverage(e, [h]) === 1)).length / 5,
  };
}

function mean(values: number[]): number { return values.reduce((a, b) => a + b, 0) / values.length; }

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function pairedInterval(groups: number[][], seed = 42, iterations = 10_000): [number, number] {
  requireValue(groups.length > 0 && groups.every(g => g.length > 0 && g.every(Number.isFinite)), "empty or nonfinite bootstrap sample");
  requireValue(Number.isInteger(iterations) && iterations >= 100 && iterations <= 100_000 && Number.isSafeInteger(seed), "invalid bootstrap settings");
  const random = rng(seed), estimates: number[] = [];
  const n = groups.reduce((sum, g) => sum + g.length, 0);
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (const group of groups)
      for (let j = 0; j < group.length; j++) sum += group[Math.floor(random() * group.length)];
    estimates.push(sum / n);
  }
  estimates.sort((a, b) => a - b);
  return [estimates[Math.floor(iterations * 0.025)], estimates[Math.ceil(iterations * 0.975) - 1]];
}

export function kappa(human: Preference[], judge: Preference[]): number | null {
  if (human.length === 0 || human.length !== judge.length) return null;
  const observed = human.filter((v, i) => v === judge[i]).length / human.length;
  const expected = PREFERENCES.reduce((sum, v) => sum +
    (human.filter(x => x === v).length / human.length) * (judge.filter(x => x === v).length / judge.length), 0);
  return expected === 1 ? null : (observed - expected) / (1 - expected);
}

function calibrationReport(input: EvaluationInput) {
  const rows = input.calibration;
  const human = rows.map(r => r.human);
  const ab = kappa(human, rows.map(r => r.judgeAB)), ba = kappa(human, rows.map(r => r.judgeBA));
  const orderDisagreement = rows.length ? rows.filter(r => r.judgeAB !== r.judgeBA).length / rows.length : null;
  const expected = input.queries.filter(q => q.split === "development").length;
  return { count: rows.length, expected, kappaAB: ab, kappaBA: ba, orderDisagreement,
    passed: rows.length === expected && rows.length >= MIN_CALIBRATION && ab !== null && ba !== null && ab >= 0.75 && ba >= 0.75 && orderDisagreement !== null && orderDisagreement <= 0.1 };
}

function answerReport(input: EvaluationInput, test: Query[]) {
  const selected = new Map(test.map(q => [q.id, q]));
  const scores: { baseline: number; candidate: number; baselineCompleteness: number; candidateCompleteness: number }[] = [];
  for (const row of input.answers) {
    if (!selected.has(row.queryId)) continue;
    const score = (arm: "baseline" | "candidate") => {
      const context = budgetedHits(input[arm].rankings[row.queryId], input.policy.contextCharacters).slice(0, 10);
      const supported = row[arm].filter(claim => claim.supported && claim.citations.every(c => coverage(c, context) === 1));
      const citations = supported.flatMap(claim => claim.citations);
      const evidence = selected.get(row.queryId)!.evidence;
      return { support: supported.length / row[arm].length,
        completeness: evidence.filter(e => coverage(e, citations) === 1).length / evidence.length };
    };
    const baseline = score("baseline"), candidate = score("candidate");
    scores.push({ baseline: baseline.support, candidate: candidate.support,
      baselineCompleteness: baseline.completeness, candidateCompleteness: candidate.completeness });
  }
  const baseline = scores.length ? mean(scores.map(s => s.baseline)) : null;
  const candidate = scores.length ? mean(scores.map(s => s.candidate)) : null;
  const baselineCompleteness = scores.length ? mean(scores.map(s => s.baselineCompleteness)) : null;
  const candidateCompleteness = scores.length ? mean(scores.map(s => s.candidateCompleteness)) : null;
  return { count: scores.length, baseline, candidate, baselineCompleteness, candidateCompleteness,
    passed: scores.length === test.length && test.length > 0 && baseline !== null && candidate !== null &&
      baselineCompleteness !== null && candidateCompleteness !== null && candidate >= 0.85 && candidateCompleteness >= 0.85 &&
      candidate - baseline >= -input.policy.maximumAnswerLoss && candidateCompleteness - baselineCompleteness >= -input.policy.maximumAnswerLoss };
}

function metricReport(rows: PairedRow[], metric: keyof Metrics) {
  const baseline = mean(rows.map(r => r.baseline[metric])), candidate = mean(rows.map(r => r.candidate[metric]));
  const groups = STRATA.map(s => rows.filter(r => r.stratum === s).map(r => r.candidate[metric] - r.baseline[metric])).filter(g => g.length > 0);
  return { baseline, candidate, delta: candidate - baseline, interval95: pairedInterval(groups) };
}

/** candidate_for_review is evidence for a HUMAN decision, never rollout permission. */
export function evaluate(input: EvaluationInput) {
  parseEvaluation(input);
  const test = input.queries.filter(q => q.split === "test");
  const rows: PairedRow[] = test.map(q => ({ queryId: q.id, stratum: q.stratum,
    baseline: scoreQuery(q, input.baseline.rankings[q.id], input.policy.contextCharacters),
    candidate: scoreQuery(q, input.candidate.rankings[q.id], input.policy.contextCharacters) }));
  const calibration = calibrationReport(input), answers = answerReport(input, test);
  const reasons: string[] = [];
  if (input.kind === "fixture" || input.queries.some(q => q.origin === "synthetic")) reasons.push("synthetic_data_is_not_rollout_evidence");
  if (test.length < MIN_QUERIES) reasons.push(`test_queries_${test.length}_below_${MIN_QUERIES}`);
  for (const s of STRATA) if (!test.some(q => q.stratum === s)) reasons.push(`missing_stratum_${s}`);
  if (!calibration.passed) reasons.push("judge_calibration_missing_or_failed");
  if (answers.count !== test.length || !test.length) reasons.push("answer_assessments_incomplete");
  const metrics = rows.length ? {
    recall10: metricReport(rows, "recall10"), precision5: metricReport(rows, "precision5"), coverage10: metricReport(rows, "coverage10"),
  } : null;
  const retrievalPass = metrics !== null && metrics.recall10.delta >= input.policy.minimumRecallGain && metrics.recall10.interval95[0] > 0 && metrics.precision5.interval95[0] >= -input.policy.maximumPrecisionLoss;
  const status = reasons.length ? "insufficient_evidence" : !answers.passed ? "answer_barrier_failed" : !retrievalPass ? "no_practical_gain" : "candidate_for_review";
  return { version: 1, experiment: input.experiment, status, reasons,
    testQueries: test.length, developmentQueries: input.queries.length - test.length,
    corpusSha256: sha256(JSON.stringify(input.documents.map(d => [d.id, d.sha256]).sort((a, b) => a[0].localeCompare(b[0])))),
    inputSha256: sha256(JSON.stringify(input)),
    policy: input.policy, bootstrap: { seed: 42, iterations: 10_000, unit: "paired_query", stratifiedBy: "query_type" },
    metrics, calibration, answers,
    strata: Object.fromEntries(STRATA.map(s => [s, rows.filter(r => r.stratum === s).length])),
    queries: rows };
}

function annotationOrder(experiment: string, queryId: string): readonly ["baseline" | "candidate", "baseline" | "candidate"] {
  const seed = Number.parseInt(sha256(JSON.stringify([experiment, queryId])).slice(0, 8), 16);
  return rng(seed)() < 0.5 ? ["baseline", "candidate"] : ["candidate", "baseline"];
}

/** Blind display data only. The decoding key has a separate explicit API. */
export function annotationTasks(input: EvaluationInput) {
  parseEvaluation(input);
  const documents = new Map(input.documents.map(d => [d.id, d.text]));
  return input.queries.filter(q => q.split === "development").map(q => {
    const arms = annotationOrder(input.experiment, q.id);
    const context = (arm: "baseline" | "candidate") => budgetedHits(input[arm].rankings[q.id], input.policy.contextCharacters).slice(0, 10)
      .map(h => ({ document: h.document, start: h.start, end: h.end, text: documents.get(h.document)!.slice(h.start, h.end) }));
    requireValue(nonempty(input.baseline.responses[q.id]) && nonempty(input.candidate.responses[q.id]), "annotation requires both actual generated answers");
    return { id: q.id, query: q.text,
      A: { context: context(arms[0]), answer: input[arms[0]].responses[q.id] },
      B: { context: context(arms[1]), answer: input[arms[1]].responses[q.id] },
      preference: null, humanRater: null };
  });
}

export function annotationKey(input: EvaluationInput): Record<string, { A: string; B: string }> {
  parseEvaluation(input);
  return Object.fromEntries(input.queries.filter(q => q.split === "development").map(q => {
    const [A, B] = annotationOrder(input.experiment, q.id);
    return [q.id, { A, B }];
  }));
}
