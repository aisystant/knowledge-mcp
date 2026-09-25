import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index.js";

const mocks = vi.hoisted(() => ({ verify: vi.fn(), enqueue: vi.fn() }));
vi.mock("./auth.js", async importOriginal => ({ ...await importOriginal<object>(), verifyJwtLocally: mocks.verify }));
vi.mock("./retrieval-observations.js", async importOriginal => ({ ...await importOriginal<object>(), enqueueObservation: mocks.enqueue }));
vi.mock("@neondatabase/serverless", () => ({ neon: vi.fn(), neonConfig: {}, Pool: vi.fn() }));
vi.mock("./rls.js", () => ({
  createRequestPool: () => ({ end: async () => {} }),
  withUserContext: async (_dsn: string, _account: string, fn: (sql: unknown) => Promise<unknown>) => {
    const sql = Object.assign(async () => [{ id: 10, filename: "fixture.md", source: "fixture", content: "Example",
      source_type: "pack", score: 1, indexed_content_hash: "a".repeat(64) }], { unsafe: (value: string) => value });
    return fn(sql);
  },
}));

const env: Env = { KNOWLEDGE_DATABASE_URL: "unused", HEALTH_DATABASE_URL: "unused", OPENROUTER_API_KEY: "unused",
  MCP_MODE: "public", ORY_URL: "https://auth.example.test", RETRIEVAL_OBSERVATION_MODE: "hash",
  RETRIEVAL_OBSERVATION_DATABASE_URL: "unused", RETRIEVAL_OBSERVATION_HMAC_KEY: "test-only-key".repeat(4),
  RETRIEVAL_OBSERVATION_ACCOUNTS: "verified-account" };

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/mcp", { method: "POST", headers, body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { query: "DP.TEST.001" } },
  }) });
}

beforeEach(() => { vi.clearAllMocks(); mocks.verify.mockResolvedValue(null); });

describe("HTTP observation identity", () => {
  it.each<Record<string, string>>([
    { "x-user-id": "verified-account" },
    { Authorization: "Bearer invalid", "x-user-id": "verified-account" },
    { Authorization: "Basic invalid", "x-user-id": "verified-account" },
  ])("never admits unverified caller identity %#", async headers => {
    const response = await worker.fetch(request(headers), env, { waitUntil: vi.fn() } as unknown as ExecutionContext);
    const body = await response.json() as { result: { content: { text: string }[] } };
    expect(JSON.parse(body.result.content[0].text)[0].observation_id).toBeUndefined();
    expect(mocks.enqueue.mock.calls[0][1]).toBeUndefined();
  });
  it("propagates only the JWT subject and returns its observation id inside the response budget", async () => {
    mocks.verify.mockResolvedValue("verified-account");
    const response = await worker.fetch(request({ Authorization: "Bearer test", "x-user-id": "other" }), env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext);
    const body = await response.json() as { result: { content: { text: string }[] } };
    const hit = JSON.parse(body.result.content[0].text)[0];
    expect(mocks.enqueue.mock.calls[0][1]).toMatchObject({ accountId: "verified-account", id: hit.observation_id });
    expect(hit.observation_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(hit).not.toHaveProperty("indexed_content_hash");
    expect(mocks.enqueue.mock.calls[0][3][0].indexed_content_hash).toBe("a".repeat(64));
  });
  it("preserves the original response without a runtime background scheduler", async () => {
    mocks.verify.mockResolvedValue("verified-account");
    const response = await worker.fetch(request({ Authorization: "Bearer test" }), env);
    expect(await response.text()).not.toContain("observation_id");
  });
});
