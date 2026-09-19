import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginObservation, makeObservation, mayRetainQueryText, enqueueObservation,
  insertObservation, recordObservationFeedback, expireObservationText, exportOwnObservations, type ObservationEnv } from "./retrieval-observations.js";
import { buildSearchToolResponse, SEARCH_TOOL_RESPONSE_BUDGET_BYTES, type SearchResult } from "./index.js";

const mock = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), release: vi.fn(), end: vi.fn(), on: vi.fn() }));
vi.mock("@neondatabase/serverless", () => ({ neon: vi.fn(), neonConfig: {},
  Pool: vi.fn(function () { return { connect: mock.connect, end: mock.end, on: mock.on }; }) }));
const env: ObservationEnv = {
  RETRIEVAL_OBSERVATION_MODE: "platform-text", RETRIEVAL_OBSERVATION_DATABASE_URL: "unused-test-dsn",
  RETRIEVAL_OBSERVATION_ACCOUNTS: "account-a,account-b", RETRIEVAL_OBSERVATION_HMAC_KEY: "test-only-key-".repeat(4),
  RETRIEVAL_OBSERVATION_TEXT_DAYS: "90",
};
const runtime = () => ({ verifiedAccountId: "account-a", waitUntil: vi.fn() });
const hit: SearchResult = { id: 10, source: "fixture", source_type: "pack", filename: "one.md", content: "Text",
  score: 1, github_url: null };

beforeEach(() => {
  vi.clearAllMocks();
  mock.query.mockImplementation(async (query: string) => ({ rows: query.includes("AS unsafe") ? [{ unsafe: false }] : [], rowCount: 0 }));
  mock.connect.mockResolvedValue({ query: mock.query, release: mock.release });
  mock.end.mockResolvedValue(undefined);
});

describe("observation admission and minimisation", () => {
  it("requires every opt-in, a verified account and the server allowlist", () => {
    expect(beginObservation({}, runtime(), "public")).toBeUndefined();
    expect(beginObservation(env, undefined, "public")).toBeUndefined();
    expect(beginObservation(env, { waitUntil: vi.fn() }, "public")).toBeUndefined();
    expect(beginObservation(env, { ...runtime(), verifiedAccountId: "account-c" }, "public")).toBeUndefined();
    expect(beginObservation({ ...env, RETRIEVAL_OBSERVATION_MODE: "typo" }, runtime(), "public")).toBeUndefined();
    expect(beginObservation({ ...env, RETRIEVAL_OBSERVATION_HMAC_KEY: "short" }, runtime(), "public")).toBeUndefined();
    expect(beginObservation(env, runtime(), "public")?.accountId).toBe("account-a");
  });
  it.each([undefined, "0", "-1", "181", "NaN", "0.5"])("never defaults invalid retention %s to text storage", async days => {
    const config = { ...env, RETRIEVAL_OBSERVATION_TEXT_DAYS: days };
    const ticket = beginObservation(config, runtime(), "public")!;
    const event = await makeObservation(config, ticket, "Понятие роли", [hit], buildSearchToolResponse(1, [hit]));
    expect(event.queryText).toBeNull();
    expect(event.textExpiresAt).toBeNull();
  });
  it("never retains personal query text even with platform text enabled", async () => {
    const ticket = beginObservation(env, runtime(), "private")!;
    const event = await makeObservation(env, ticket, "Личный план", [hit], buildSearchToolResponse(1, [hit]));
    expect(event.queryText).toBeNull();
    expect(event.textDisposition).toBe("private");
  });
  it.each([
    "Bearer example-token", "sk-" + "x".repeat(32), "ghp_" + "x".repeat(32),
    "github_pat_" + "x".repeat(32), "xoxb-123-123-ABC", "xoxe-example",
    "AKIA" + "A".repeat(16), "AIza" + "a".repeat(35), "-----BEGIN RSA PRIVATE KEY-----",
    "123456789:" + "a".repeat(35), "eyJabc.eyJabc.signature", "postgres://user:fake@host/db",
    "https://user:fake@host/", "M" + "a".repeat(23) + ".abcdef." + "a".repeat(27),
    "123-456-789 01", "user@example.test", "+7 (999) 123-45-67", "192.168.1.1",
    "12345678-1234-1234-1234-123456789012", "пароль: example", "ＡＫＩＡ" + "Ａ".repeat(16),
  ])("filters sensitive-pattern family %#", async query => {
    expect(mayRetainQueryText(query)).toBe(false);
    const event = await makeObservation(env, beginObservation(env, runtime(), "public")!, query, [], buildSearchToolResponse(1, []));
    expect(event.queryText).toBeNull();
    expect(event.textDisposition).toBe("filtered");
    expect(JSON.stringify(event)).not.toContain(query);
  });
  it("retains eligible platform text for the explicit period and fingerprints per account", async () => {
    const ticket = beginObservation(env, runtime(), "public")!;
    const query = "Что такое роль?";
    const response = buildSearchToolResponse(1, []);
    const a = await makeObservation(env, ticket, query, [], response);
    const equivalent = await makeObservation(env, ticket, `  ${query} `, [], response);
    const b = await makeObservation(env, { ...ticket, accountId: "account-b" }, query, [], response);
    expect(a.queryText).toBe(query);
    expect(Date.parse(a.textExpiresAt!) - Date.parse(a.observedAt)).toBe(90 * 86_400_000);
    expect(a.queryFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(a.queryFingerprint).toBe(equivalent.queryFingerprint);
    expect(a.queryFingerprint).not.toBe(b.queryFingerprint);
  });
});

describe("actual returned snapshot", () => {
  it("records ranking and separate indexed/returned content hashes after excerpts and truncation", async () => {
    const available = Array.from({ length: 21 }, (_, i) => ({ ...hit, id: 21 - i, content: "😀".repeat(3000), parent_content: "p".repeat(4000) }));
    const ticket = beginObservation(env, runtime(), "public")!;
    const response = buildSearchToolResponse(1, available, SEARCH_TOOL_RESPONSE_BUDGET_BYTES, ticket.id);
    expect(new TextEncoder().encode(JSON.stringify(response)).length).toBeLessThanOrEqual(SEARCH_TOOL_RESPONSE_BUDGET_BYTES);
    const event = await makeObservation(env, ticket, "Части системы", available, response);
    const returned = JSON.parse((response.result as { content: { text: string }[] }).content[0].text);
    expect(event.snapshot.hits.map(value => value.id)).toEqual(returned.map((value: SearchResult) => value.id));
    expect(event.snapshot.returnedCount).toBe(returned.length);
    expect(event.snapshot.availableCount).toBe(21);
    expect(event.snapshot.omittedHits).toBe(true);
    expect(event.snapshot.hits[0]).toMatchObject({ id: 21, rank: 1, excerpted: true });
    expect(event.snapshot.hits[0].retrievedContentHash).not.toBe(event.snapshot.hits[0].returnedContentHash);
    expect(returned.every((value: { observation_id: string }) => value.observation_id === ticket.id)).toBe(true);
    expect(JSON.stringify(event)).not.toContain(available[0].filename);
  });
  it("detects reindexed contents even if the numeric id was reused", async () => {
    const ticket = beginObservation(env, runtime(), "public")!;
    const a = await makeObservation(env, ticket, "q", [hit], buildSearchToolResponse(1, [hit]));
    const changed = { ...hit, content: "Changed" };
    const b = await makeObservation(env, ticket, "q", [changed], buildSearchToolResponse(1, [changed]));
    expect(a.snapshot.hits[0].retrievedContentHash).not.toBe(b.snapshot.hits[0].retrievedContentHash);
  });
  it("retains full indexed version when the DB has already returned a shortened excerpt", async () => {
    const available = [{ ...hit, indexed_content_hash: "b".repeat(64) }];
    const event = await makeObservation(env, beginObservation(env, runtime(), "public")!, "q", available, buildSearchToolResponse(1, available));
    expect(event.snapshot.hits[0]).toMatchObject({ indexedContentHash: "b".repeat(64), excerpted: true });
    expect(event.snapshot.hits[0].retrievedContentHash).toBe(event.snapshot.hits[0].returnedContentHash);
  });
});

describe("bounded isolated persistence", () => {
  it("schedules without awaiting a stalled connection and contains storage errors without row text", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    let rejectConnection!: (reason: Error) => void;
    mock.connect.mockReturnValue(new Promise((_, reject) => { rejectConnection = reject; }));
    const rt = runtime();
    const ticket = beginObservation(env, rt, "public")!;
    expect(enqueueObservation(env, ticket, "query", [hit], buildSearchToolResponse(1, [hit]))).toBeUndefined();
    expect(rt.waitUntil).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mock.connect).toHaveBeenCalledOnce());
    rejectConnection(new Error("secret row content should never reach stderr"));
    await rt.waitUntil.mock.calls[0][0];
    expect(log.mock.calls).toEqual([["[retrieval-observations] operation_failed"]]);
    expect(mock.end).toHaveBeenCalledOnce();
    log.mockRestore();
  });
  it("uses transaction-local identity and parameterised row writes", async () => {
    const event = await makeObservation(env, beginObservation(env, runtime(), "public")!, "question", [hit], buildSearchToolResponse(1, [hit]));
    await insertObservation(env, event);
    expect(mock.query).toHaveBeenCalledWith("SELECT set_config('app.account_id', $1, true)", ["account-a"]);
    const insert = mock.query.mock.calls.find(([q]) => q.includes("INSERT INTO retrieval.observation"))!;
    expect(insert[0]).not.toContain("question");
    expect(insert[1]).toContain("question");
    expect(mock.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(mock.release).toHaveBeenCalledOnce();
  });
  it("refuses a database owner or RLS-bypass role before writing and rolls back", async () => {
    mock.query.mockResolvedValue({ rows: [{ unsafe: true }] });
    const event = await makeObservation(env, beginObservation(env, runtime(), "public")!, "q", [], buildSearchToolResponse(1, []));
    await expect(insertObservation(env, event)).rejects.toThrow("observation_role_not_isolated");
    expect(mock.query.mock.calls.some(([q]) => q.includes("INSERT"))).toBe(false);
    expect(mock.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mock.release).toHaveBeenCalledOnce();
  });
  it("reports missing/not-yet-written observations without falling back to unbound feedback", async () => {
    const result = await recordObservationFeedback(env, runtime(), { observation_id: crypto.randomUUID(), document_id: 10, helpfulness: true });
    expect(result).toEqual({ recorded: false, reason: "observation_or_hit_unavailable_retry" });
  });
  it("stores citation signal separately from helpfulness and validates identifiers", async () => {
    expect(await recordObservationFeedback(env, runtime(), { observation_id: "invalid", document_id: 10, helpfulness: true })).toMatchObject({ recorded: false });
    expect(mock.connect).not.toHaveBeenCalled();
    mock.query.mockImplementation(async (q: string) => ({ rows: q.includes("AS unsafe") ? [{ unsafe: false }] : [], rowCount: 1 }));
    const id = crypto.randomUUID();
    expect(await recordObservationFeedback(env, runtime(), { observation_id: id, document_id: 10, helpfulness: false, cited: true })).toEqual({ recorded: true });
    const insert = mock.query.mock.calls.find(([q]) => q.includes("INSERT INTO retrieval.citation_feedback"))!;
    expect(insert[1]).toEqual(["account-a", id, 10, false, true]);
    expect(insert[0]).toContain("jsonb_array_elements");
  });
  it("runs expiry even with collection disabled", async () => {
    await expireObservationText({ ...env, RETRIEVAL_OBSERVATION_MODE: "off" });
    expect(mock.query).toHaveBeenCalledWith("SELECT retrieval.expire_text()");
  });
  it("exports only the verified caller's unexpired platform candidates through the RLS view", async () => {
    await expect(exportOwnObservations(env, "")).rejects.toThrow("export_unavailable");
    expect(mock.connect).not.toHaveBeenCalled();
    mock.query.mockImplementation(async (q: string) => ({ rows: q.includes("AS unsafe") ? [{ unsafe: false }]
      : q.includes("observation_export") ? [{ id: "candidate" }] : [], rowCount: 1 }));
    expect(await exportOwnObservations(env, "account-a")).toEqual([{ id: "candidate" }]);
    const query = mock.query.mock.calls.find(([q]) => q.includes("observation_export"))!;
    expect(query[1]).toEqual(["account-a"]);
    expect(query[0]).toContain("mode = 'public' AND query_text IS NOT NULL");
    expect(query[0]).toContain("LIMIT 1000");
  });
});
