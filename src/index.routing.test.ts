// Integration-level routing test for the dual-mode dispatcher (WP-410 срез-2b).
//
// Reviewer finding (peer-session 2026-07-01-27, cold-review): the invariant "private mode
// routes search/get_document/list_sources to the personal-corpus layer and NEVER reaches the
// public account_id-IS-NULL code" was only verified by manual code reading, with no regression
// test. This file closes that gap by mocking layers/private.js (JwtScopeGuard — no real JWT
// verification) and layers/personal.js (the ported personal-corpus functions), then asserting
// the dispatcher's response carries the PRIVATE-layer sentinel data, never public-layer data.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@neondatabase/serverless", () => ({
  neon: vi.fn(() => {
    const sql = ((..._args: unknown[]) => Promise.resolve([])) as unknown as {
      (..._args: unknown[]): Promise<unknown[]>;
      unsafe: (v: string) => string;
    };
    sql.unsafe = (v: string) => v;
    return sql;
  }),
  neonConfig: {},
  Pool: vi.fn(),
}));

vi.mock("./rls.js", () => ({
  // Public-mode code path (searchDocuments/getDocument/listSources via withUserContext) would
  // resolve here if the private-router failed to return early — return an obviously-public
  // sentinel row so a routing regression fails the assertions below instead of silently passing.
  withUserContext: vi.fn(async (_dsn: string, _userId: string | null | undefined, fn: (sql: unknown) => Promise<unknown>) => {
    const sql = ((..._args: unknown[]) => Promise.resolve([
      { legacy_id: 1, source_uri: "PUBLIC_LEAK.md", content: "public corpus content", source: "public-src", source_kind: "guides" },
    ])) as unknown as { (..._args: unknown[]): Promise<unknown[]>; unsafe: (v: string) => string };
    sql.unsafe = (v: string) => v;
    return fn(sql);
  }),
}));

vi.mock("./layers/personal.js", () => ({
  resolveUserContext: vi.fn().mockResolvedValue({
    userId: "user-private-1",
    sources: [{ source: "DS-my-strategy", githubOwner: "TserenTserenov", githubRepo: "DS-my-strategy", pathPrefix: "", sourceType: "ds" }],
    sourceNames: ["DS-my-strategy"],
  }),
  personalSearchDocuments: vi.fn().mockResolvedValue([
    { filename: "PRIVATE_SENTINEL.md", content: "private note content", source: "DS-my-strategy", source_type: "ds", score: 0.9, github_url: null },
  ]),
  personalGetDocument: vi.fn().mockResolvedValue({
    filename: "PRIVATE_SENTINEL.md", content: "private note content", source: "DS-my-strategy", source_type: "ds", github_url: null,
  }),
  personalListSources: vi.fn().mockResolvedValue([
    { source: "PRIVATE_SENTINEL_SOURCE", source_type: "ds", doc_count: 1 },
  ]),
  personalMemorySearch: vi.fn().mockResolvedValue([]),
  connectSource: vi.fn(),
  writeToGitHub: vi.fn(),
  deleteFromGitHub: vi.fn(),
}));

// Bypass real Ory JWT verification — routing tests care about mode-based dispatch, not auth.
// Must be a `class` (not an arrow-returning vi.fn) — the dispatcher calls `new JwtScopeGuard(...)`.
class FakeJwtScopeGuard {
  async authenticate() {
    return { userId: "user-private-1" };
  }
  async authorize() {
    return undefined;
  }
}

vi.mock("./layers/private.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./layers/private.js")>();
  return { ...actual, JwtScopeGuard: FakeJwtScopeGuard };
});

const { handleMcpRequest, default: worker } = await import("./index.js");
const { personalSearchDocuments, personalGetDocument, personalListSources, writeToGitHub } = await import("./layers/personal.js");

const ENV = {
  KNOWLEDGE_DATABASE_URL: "postgres://fake-public",
  HEALTH_DATABASE_URL: "postgres://fake-health",
  OPENROUTER_API_KEY: "fake",
  DATABASE_URL: "postgres://fake-personal",
  ORY_URL: "https://auth.example.com/hydra",
} as import("./index.js").Env;

function callTool(name: string, args: Record<string, unknown>, mode: "public" | "private") {
  return handleMcpRequest(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } as never,
    ENV,
    undefined,
    mode,
    new Request("https://x/mcp", { headers: { Authorization: "Bearer fake-jwt" } })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dual-mode routing: private mode reaches the personal layer, never the public layer", () => {
  it("search: private mode returns the personal-layer sentinel, not the public corpus", async () => {
    const res = await callTool("search", { query: "test" }, "private");
    const text = (res as { result: { content: [{ text: string }] } }).result.content[0].text;
    expect(text).toContain("PRIVATE_SENTINEL.md");
    expect(text).not.toContain("PUBLIC_LEAK.md");
    expect(personalSearchDocuments).toHaveBeenCalledTimes(1);
  });

  it("get_document: private mode returns the personal-layer sentinel content", async () => {
    const res = await callTool("get_document", { filename: "PRIVATE_SENTINEL.md" }, "private");
    const text = (res as { result: { content: [{ text: string }] } }).result.content[0].text;
    expect(text).toBe("private note content");
    expect(personalGetDocument).toHaveBeenCalledTimes(1);
  });

  it("list_sources: private mode returns the personal-layer sentinel, not the public corpus", async () => {
    const res = await callTool("list_sources", {}, "private");
    const text = (res as { result: { content: [{ text: string }] } }).result.content[0].text;
    expect(text).toContain("PRIVATE_SENTINEL_SOURCE");
    expect(personalListSources).toHaveBeenCalledTimes(1);
  });

  it("search: public mode never calls the personal-layer search function", async () => {
    await callTool("search", { query: "test" }, "public");
    expect(personalSearchDocuments).not.toHaveBeenCalled();
  });

  it("write: domain guidance stays a structured non-MCP-error result", async () => {
    vi.mocked(writeToGitHub).mockResolvedValueOnce({
      success: false,
      reason: "post_scaffold_required",
      error: "creation blocked",
      next_action: "run scripts/new-post.py",
    });

    const res = await callTool("write", {
      source: "DS-my-strategy",
      path: "docs/post.md",
      content: "---\ntype: post\n---",
    }, "private") as { result: { content: [{ text: string }]; isError?: boolean } };

    expect(res.result.isError).toBeUndefined();
    expect(JSON.parse(res.result.content[0].text)).toMatchObject({
      success: false,
      reason: "post_scaffold_required",
      next_action: "run scripts/new-post.py",
    });
  });
});

describe("/reindex route guard (WP-7 Ф100 fail-closed, peer session 2026-08-30-14)", () => {
  const reindexEnv = {
    ...ENV,
    REINDEX_SECRET: "platform-secret",
    PERSONAL_REINDEX_SECRET: "personal-secret",
  } as import("./index.js").Env;

  function reindexRequest(secret: string) {
    return new Request("https://x/reindex", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ source: "no-such-source", files: [] }),
    });
  }

  it("refuses the personal secret with 403 — a personal push must not reach the platform indexer", async () => {
    const res = await worker.fetch(reindexRequest("personal-secret"), reindexEnv, {} as never);
    expect(res.status).toBe(403);
    const body = await res.json() as { reason: string };
    expect(body.reason).toBe("personal_reindex_not_supported_by_unified_tree");
  });

  it("fails closed with 503 when both secrets are configured equal (callers indistinguishable)", async () => {
    const equalEnv = { ...reindexEnv, PERSONAL_REINDEX_SECRET: "platform-secret" } as import("./index.js").Env;
    const res = await worker.fetch(reindexRequest("platform-secret"), equalEnv, {} as never);
    expect(res.status).toBe(503);
    const body = await res.json() as { reason: string };
    expect(body.reason).toBe("reindex_secrets_not_distinguishable");
  });

  it("still lets the platform secret through to the platform indexer", async () => {
    const res = await worker.fetch(reindexRequest("platform-secret"), reindexEnv, {} as never);
    expect(res.status).toBe(200);
    const body = await res.json() as { chunks: { errors: string[] } };
    // Guard passed; the unknown-source error proves the request reached reindexFiles.
    expect(body.chunks.errors[0]).toContain("Unknown source");
  });

  it("still refuses a wrong secret with 401", async () => {
    const res = await worker.fetch(reindexRequest("wrong"), reindexEnv, {} as never);
    expect(res.status).toBe(401);
  });
});
