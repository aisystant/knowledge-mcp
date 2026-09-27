import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { annotationKey, annotationTasks, budgetedHits, coverage, evaluate, kappa, pairedInterval, parseEvaluation, scoreQuery, sha256, type EvaluationInput, type Query, type Preference } from "./retrieval-evaluation.js";

function fixture(testCount = 4, calibrationCount = 0): EvaluationInput {
  const text = "The answer is here. Some unrelated words. Another supported answer.";
  const input: EvaluationInput = {
    version: 1, kind: "fixture", experiment: "synthetic-contract-test",
    preregisteredAt: "2026-09-18T00:00:00Z",
    policy: { minimumRecallGain: 0.05, maximumPrecisionLoss: 0.02, maximumAnswerLoss: 0, contextCharacters: 100, changedConfigKeys: ["retriever"] },
    documents: [{ id: "doc", text, sha256: sha256(text) }], queries: [],
    baseline: { id: "baseline", completedAt: "2026-09-19T00:00:00Z", config: { retriever: "legacy", embedding: "fixed" }, rankings: {}, responses: {} },
    candidate: { id: "candidate", completedAt: "2026-09-19T00:00:00Z", config: { retriever: "rrf", embedding: "fixed" }, rankings: {}, responses: {} },
    judge: { model: "test-model", promptSha256: sha256("test prompt") }, calibration: [], answers: [],
  };
  for (let i = 0; i < testCount + calibrationCount; i++) {
    const id = `q${i}`;
    const split = i < testCount ? "test" : "development";
    input.queries.push({ id, text: `Distinct test question ${i}`, stratum: (["identifier", "concept", "procedure", "hard"] as const)[i % 4], split, origin: "synthetic", annotator: "test-only", evidence: [{ id: "answer", document: "doc", start: 0, end: 19 }] });
    input.baseline.rankings[id] = [{ id: "noise", document: "doc", start: 20, end: 40 }];
    input.candidate.rankings[id] = [{ id: "answer", document: "doc", start: 0, end: 19 }];
    input.baseline.responses[id] = "An unrelated answer.";
    input.candidate.responses[id] = "The answer is here.";
    if (split === "development") {
      const preference: Preference = (["candidate", "baseline", "tie"] as const)[i % 3];
      input.calibration.push({ queryId: id, humanRater: "test-only", human: preference, judgeAB: preference, judgeBA: preference });
    } else {
      input.answers.push({ queryId: id,
        baseline: [{ start: 0, end: input.baseline.responses[id].length, supported: false, citations: [{ document: "doc", start: 20, end: 40 }] }],
        candidate: [{ start: 0, end: input.candidate.responses[id].length, supported: true, citations: [{ document: "doc", start: 0, end: 19 }] }],
      });
    }
  }
  return input;
}

describe("source-span metrics", () => {
  const evidence = { document: "d", start: 10, end: 30 };
  it("unions overlapping fragments without double-counting", () => {
    expect(coverage(evidence, [{ document: "d", start: 5, end: 20 }, { document: "d", start: 15, end: 25 }])).toBe(0.75);
    expect(coverage(evidence, [{ document: "other", start: 0, end: 100 }])).toBe(0);
    expect(coverage(evidence, [{ document: "d", start: 10, end: 20 }, { document: "d", start: 20, end: 30 }])).toBe(1);
  });
  it("does not count the vicinity of the answer as a recall hit", () => {
    const q = { evidence: [{ id: "e", ...evidence }] } as Query;
    expect(scoreQuery(q, [{ id: "h", document: "d", start: 10, end: 20 }], 100)).toEqual({ recall10: 0, coverage10: 0.5, precision5: 0 });
    expect(scoreQuery(q, [{ id: "h", ...evidence }], 100)).toEqual({ recall10: 1, coverage10: 1, precision5: 0.2 });
  });
  it("keeps the top-k denominator when fewer results are returned", () => {
    const input = fixture();
    expect(scoreQuery(input.queries[0], [], 100)).toEqual({ recall10: 0, coverage10: 0, precision5: 0 });
    expect(scoreQuery(input.queries[0], input.candidate.rankings.q0, 100).precision5).toBe(0.2);
  });
  it("does not include an answer ranked eleventh", () => {
    const q = { evidence: [{ id: "e", ...evidence }] } as Query;
    const hits = Array.from({ length: 10 }, (_, i) => ({ id: `noise${i}`, document: "other", start: 0, end: 1 }));
    hits.push({ id: "answer", ...evidence });
    expect(scoreQuery(q, hits, 100).recall10).toBe(0);
  });
  it("stops at the shared budget and never skips a long higher-ranked result", () => {
    const hits = [{ id: "big", document: "d", start: 0, end: 101 }, { id: "small", document: "d", start: 10, end: 20 }];
    expect(budgetedHits(hits, 100)).toEqual([]);
    expect(budgetedHits(hits, 111)).toEqual(hits);
  });
  it("separates ranking precision from context-budget recall", () => {
    const q = { evidence: [{ id: "e", document: "d", start: 0, end: 10 }] } as Query;
    const hits = [{ id: "noise", document: "d", start: 100, end: 200 }, { id: "answer", document: "d", start: 0, end: 10 }];
    expect(scoreQuery(q, hits, 105)).toEqual({ recall10: 0, coverage10: 0, precision5: 0.2 });
    expect(scoreQuery(q, hits, 110)).toEqual({ recall10: 1, coverage10: 1, precision5: 0.2 });
  });
});

describe("input integrity", () => {
  it("accepts an explicit synthetic fixture", () => expect(parseEvaluation(fixture()).kind).toBe("fixture"));
  const invalid: [string, (input: EvaluationInput) => void][] = [
    ["hash", i => { i.documents[0].text += "changed"; }],
    ["duplicate query", i => { i.queries[1].id = i.queries[0].id; }],
    ["normalized duplicate", i => { i.queries[1].text = ` ${i.queries[0].text.toUpperCase()} `; }],
    ["missing evidence", i => { i.queries[0].evidence = []; }],
    ["negative span", i => { i.queries[0].evidence[0].start = -1; }],
    ["fractional offset", i => { i.queries[0].evidence[0].start = 0.1; }],
    ["unknown document", i => { i.queries[0].evidence[0].document = "missing"; }],
    ["missing ranking", i => { delete i.candidate.rankings.q0; }],
    ["extra ranking", i => { i.candidate.rankings.extra = []; }],
    ["duplicate result", i => { i.candidate.rankings.q0.push(i.candidate.rankings.q0[0]); }],
    ["duplicate span", i => { i.candidate.rankings.q0.push({ ...i.candidate.rankings.q0[0], id: "alias" }); }],
    ["mutating chunk ID", i => { i.candidate.rankings.q1[0].end = 18; }],
    ["post-hoc registration", i => { i.preregisteredAt = "2026-09-20T00:00:00Z"; }],
    ["timezone missing", i => { i.preregisteredAt = "2026-09-18"; }],
    ["undeclared config difference", i => { i.candidate.config.embedding = "new"; }],
    ["NaN policy", i => { i.policy.minimumRecallGain = NaN; }],
    ["missing citation", i => { i.answers[0].candidate[0].citations = []; }],
    ["omitted false claim", i => { i.candidate.responses.q0 += " False claim."; }],
    ["omitted generated answer", i => { delete i.candidate.responses.q0; }],
    ["unassessed first claim", i => { i.answers[0].candidate[0].start = 5; }],
    ["unknown answer query", i => { i.answers[0].queryId = "missing"; }],
  ];
  it.each(invalid)("rejects %s", (_name, mutate) => {
    const input = fixture(); mutate(input);
    expect(() => parseEvaluation(input)).toThrow("Invalid evaluation:");
  });
  it("rejects human calibration on held-out queries", () => {
    const input = fixture(4, 1); input.calibration[0].queryId = "q0";
    expect(() => parseEvaluation(input)).toThrow("development queries only");
  });
  it("rejects offsets through a Unicode surrogate pair", () => {
    const input = fixture(); input.documents[0].text = "😀" + input.documents[0].text;
    input.documents[0].sha256 = sha256(input.documents[0].text); input.queries[0].evidence[0].start = 1;
    expect(() => parseEvaluation(input)).toThrow("surrogate pair");
  });
});

describe("statistics and calibration", () => {
  it("bootstraps paired deltas deterministically and preserves strata", () => {
    expect(pairedInterval([[0.5, 0.5], [-0.5, -0.5]], 42, 100)).toEqual([0, 0]);
    const groups = [[-1, 0, 1], [0.2, 0.4]];
    expect(pairedInterval(groups)).toEqual(pairedInterval(groups));
    expect(pairedInterval(groups)[0]).toBeLessThan(pairedInterval(groups)[1]);
    expect(() => pairedInterval([[]])).toThrow();
  });
  it("preserves observed query proportions for unequal strata (not macro .5)", () => {
    expect(pairedInterval([[1], Array(9).fill(0)])).toEqual([0.1, 0.1]);
  });
  it("does not treat degenerate perfect agreement as a calibrated judge", () => {
    expect(kappa(["tie", "tie"], ["tie", "tie"])).toBeNull();
    expect(kappa(["baseline", "candidate", "tie"], ["baseline", "candidate", "tie"])).toBe(1);
    expect(kappa(["baseline", "candidate"], ["candidate", "baseline"])).toBe(-1);
  });
  it("flags order-sensitive judges", () => {
    const input = fixture(4, 50);
    input.calibration.forEach(r => { r.judgeBA = "candidate"; });
    expect(evaluate(input).calibration.passed).toBe(false);
  });
  it("rejects cherry-picking 50 of 60 development queries", () => {
    const input = fixture(4, 60); input.calibration = input.calibration.slice(0, 50);
    expect(evaluate(input).calibration.passed).toBe(false);
  });
});

describe("evidence gate", () => {
  it("never promotes synthetic data, even with 200+ apparently perfect results", () => {
    const report = evaluate(fixture(200, 50));
    expect(report.metrics?.recall10.delta).toBe(1);
    expect(report.calibration.passed).toBe(true);
    expect(report.status).toBe("insufficient_evidence");
    expect(report.reasons).toContain("synthetic_data_is_not_rollout_evidence");
  });
  it("reports missing data instead of a false result", () => {
    const input = fixture(); input.answers = [];
    const report = evaluate(input);
    expect(report.status).toBe("insufficient_evidence");
    expect(report.reasons).toContain("test_queries_4_below_200");
    expect(report.reasons).toContain("answer_assessments_incomplete");
    expect(report.reasons).toContain("judge_calibration_missing_or_failed");
  });
  // These branches exercise the contract only. Metadata is not proof of human provenance.
  function declaredExperiment(): EvaluationInput {
    const input = fixture(200, 50); input.kind = "experiment";
    input.queries.forEach(q => { q.origin = "platform_log"; });
    return input;
  }
  it("permits review only when all declared evidence gates pass", () => {
    expect(evaluate(declaredExperiment()).status).toBe("candidate_for_review");
  });
  it("does not call equal pipelines improved", () => {
    const input = declaredExperiment(); input.candidate.rankings = structuredClone(input.baseline.rankings);
    input.candidate.responses = structuredClone(input.baseline.responses);
    input.answers.forEach(a => { a.candidate = structuredClone(a.baseline); });
    expect(evaluate(input).status).toBe("answer_barrier_failed");
    input.baseline.rankings = structuredClone(fixture(200, 50).candidate.rankings);
    input.candidate.rankings = structuredClone(input.baseline.rankings);
    input.answers = fixture(200, 50).answers;
    input.candidate.responses = fixture(200, 50).candidate.responses;
    expect(evaluate(input).status).toBe("no_practical_gain");
  });
  it("rejects citations outside the actually retrieved context", () => {
    const input = declaredExperiment();
    input.answers.forEach(a => { a.candidate[0].citations = [{ document: "doc", start: 42, end: 60 }]; });
    const report = evaluate(input);
    expect(report.answers.candidate).toBe(0);
    expect(report.status).toBe("answer_barrier_failed");
  });
  it("fails a truthful but incomplete answer", () => {
    const input = declaredExperiment();
    input.queries.filter(q => q.split === "test").forEach(q => {
      q.evidence.push({ id: "second-answer", document: "doc", start: 42, end: 60 });
      input.candidate.rankings[q.id].push({ id: "second", document: "doc", start: 42, end: 60 });
    });
    const report = evaluate(input);
    expect(report.metrics?.recall10.candidate).toBe(1);
    expect(report.answers.candidate).toBe(1);
    expect(report.answers.candidateCompleteness).toBe(0.5);
    expect(report.status).toBe("answer_barrier_failed");
  });
  it("keeps the blind packet separate from its decoding key", () => {
    const input = fixture(4, 50), tasks = annotationTasks(input), key = annotationKey(input);
    expect(tasks).toHaveLength(50);
    expect(tasks.every(t => t.preference === null && t.humanRater === null)).toBe(true);
    expect(JSON.stringify(tasks)).not.toMatch(/baseline|candidate/);
    expect(new Set(Object.values(key).map(k => k.A)).size).toBe(2);
    expect(annotationTasks(input)).toEqual(tasks);
    input.queries.reverse();
    expect(annotationKey(input)).toEqual(key);
    expect(annotationTasks(input).reverse()).toEqual(tasks);
  });
  it("never exports pipeline-specific hit IDs to the annotator", () => {
    const input = fixture(4, 50);
    Object.values(input.candidate.rankings).forEach(hits => { hits[0].id = "secret-pipeline-label"; });
    expect(JSON.stringify(annotationTasks(input))).not.toContain("secret-pipeline-label");
  });
});

describe("command-line contract", () => {
  it("returns nonzero with a structured report for insufficient evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "wp579-eval-"));
    try {
      const file = join(dir, "input.json"); writeFileSync(file, JSON.stringify(fixture()));
      const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/evaluate-retrieval.ts", "compare", file], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).status).toBe("insufficient_evidence");
      const malformed = spawnSync(process.execPath, ["--import", "tsx", "scripts/evaluate-retrieval.ts", "compare"], { encoding: "utf8" });
      expect(malformed.status).toBe(2);
      expect(malformed.stderr).toContain("Usage:");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
