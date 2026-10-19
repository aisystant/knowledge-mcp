import { ReadFailure } from "./read-failure.js";
// Integration-level routing test for the dual-mode dispatcher (WP-410 срез-2b).
//
// Reviewer finding (peer-session 2026-07-01-27, cold-review): the invariant "private mode
// routes search/get_document/list_sources to the personal-corpus layer and NEVER reaches the
// public account_id-IS-NULL code" was only verified by manual code reading, with no regression
// test. This file closes that gap by mocking layers/private.js (JwtScopeGuard — no real JWT
// verification) and layers/personal.js (the ported personal-corpus functions), then asserting
// the dispatcher's response carries the PRIVATE-layer sentinel data, never public-layer data.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { neon } from "@neondatabase/serverless";

// personalDb() (layers/personal.js) is just `neon(env.DATABASE_URL)` in production — the
// mock below must go through this SAME vi.fn so a single mockImplementationOnce override
// on `neon` (imported below) affects both direct db(env) callers and personalDb() callers.
const { mockNeon } = vi.hoisted(() => {
  const defaultSql = (..._args: unknown[]) => Promise.resolve([]);
  (defaultSql as unknown as { unsafe: (v: string) => string }).unsafe = (v: string) => v;
  return { mockNeon: vi.fn((..._args: unknown[]) => defaultSql) };
});

vi.mock("@neondatabase/serverless", () => ({
  neon: mockNeon,
  neonConfig: {},
  Pool: vi.fn(),
}));

vi.mock("./rls.js", () => ({
  // Public-mode code path (searchDocuments/getDocument/listSources via withUserContext) would
  // resolve here if the private-router failed to return early — return an obviously-public
  // sentinel row so a routing regression fails the assertions below instead of silently passing.
  withUserContext: vi.fn(async (_dsn: string, _userId: string | null | undefined, fn: (sql: unknown) => Promise<unknown>) => {
    const sql = ((..._args: unknown[]) => Promise.resolve([
      // The mock doesn't parse the SQL text, so it can't apply a query's own column aliases
      // (e.g. listDocuments/listPath's `source_uri AS filename`) — both the raw and the
      // aliased key are included so every public-mode caller (raw-column and aliased-SELECT
      // alike) finds the field name it actually reads.
      {
        legacy_id: 1,
        source_uri: "PUBLIC_LEAK.md",
        filename: "PUBLIC_LEAK.md",
        content: "public corpus content",
        source: "public-src",
        source_kind: "guides",
        source_type: "guides",
        // WP-7 Ф122: listDocuments aliases MAX(octet_length(content)) AS size_bytes in real
        // SQL — the mock can't compute that from `content` itself, so the value is supplied
        // directly (byte length of "public corpus content" above, ASCII so char count = byte
        // count). listPath computes its own size_bytes from `content` in JS, no mock key needed.
        size_bytes: 21,
      },
    ])) as unknown as { (..._args: unknown[]): Promise<unknown[]>; unsafe: (v: string) => string };
    sql.unsafe = (v: string) => v;
    return fn(sql);
  }),
}));

vi.mock("./layers/personal.js", () => ({
  AmbiguousSourceError: class extends Error {
    constructor(public readonly sources: string[]) { super("Ambiguous source"); }
  },
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
  // WP-7 Ф117: list_documents/list_path used to have no entry here at all — DUAL_MODE_TOOL_NAMES
  // didn't list them, so private mode fell through to the public account_id-IS-NULL handler.
  personalListDocuments: vi.fn().mockResolvedValue([
    { filename: "PRIVATE_SENTINEL.md", source: "DS-my-strategy", source_type: "ds", github_url: null },
  ]),
  personalListPath: vi.fn().mockResolvedValue([
    { type: "file", source: "DS-my-strategy", path: "PRIVATE_SENTINEL.md", title: null },
  ]),
  personalMemorySearch: vi.fn().mockResolvedValue([]),
  // WP-7 Ф176: not exercised before this session added the feature — get_document(ref)
  // and history/personal_history both go through these, distinct from the plain
  // personalGetDocument above (index-backed, no ref support).
  personalGetDocumentWithSha: vi.fn().mockResolvedValue({
    kind: "document", filename: "PRIVATE_SENTINEL.md", content: "private note content",
    source: "DS-my-strategy", source_type: "ds", github_url: null, sha: "a".repeat(40),
  }),
  personalGetDocumentHistory: vi.fn().mockResolvedValue({
    success: true,
    entries: [{ sha: "a".repeat(40), message: "PRIVATE_SENTINEL commit", date: "2026-09-26T00:00:00Z", author: "Tester" }],
  }),
  connectSource: vi.fn(),
  writeToGitHub: vi.fn(),
  appendToGitHub: vi.fn(),
  strReplaceInGitHub: vi.fn(),
  deleteFromGitHub: vi.fn(),
  // Real personalDb() is just neon(env.DATABASE_URL) — delegate to the same mockNeon
  // so overriding `neon` (e.g. vi.mocked(neon).mockImplementationOnce(...) in a test)
  // affects personalDb() callers (startReindexJob, the bridge-scopes ownership check)
  // too, not just direct db(env) callers.
  personalDb: vi.fn((env: { DATABASE_URL?: string }) => mockNeon(env.DATABASE_URL as string)),
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

const { handleMcpRequest, TOOLS, default: worker } = await import("./index.js");
const { AmbiguousSourceError, resolveUserContext, personalSearchDocuments, personalGetDocument, personalGetDocumentWithSha, personalGetDocumentHistory, personalListSources, personalListDocuments, personalListPath, writeToGitHub, appendToGitHub, strReplaceInGitHub, deleteFromGitHub } = await import("./layers/personal.js");

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
  it("requires a confirmed SHA and a strict scope check before personal deletion", async () => {
    const sha = "a".repeat(40);
    const authorize = vi.spyOn(FakeJwtScopeGuard.prototype, "authorize");
    vi.mocked(deleteFromGitHub).mockResolvedValueOnce({ success: true });
    const response = await callTool("delete", { source: "DS-my-strategy", path: "notes/a.md", expected_sha: sha }, "private");
    expect(authorize).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      policy: "required",
      toolName: "personal_write",
      args: expect.objectContaining({ source: "DS-my-strategy", path: "notes/a.md" }),
    }));
    expect(deleteFromGitHub).toHaveBeenCalledWith(expect.anything(), expect.anything(), "DS-my-strategy", "notes/a.md", expect.any(String), sha);
    expect((response.result as { isError?: boolean }).isError).toBeUndefined();
    const listed = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" } as never, ENV, undefined, "private");
    const deleteTool = (listed.result as { tools: Array<{ name: string; inputSchema: { required: string[] } }> }).tools.find(tool => tool.name === "delete");
    expect(deleteTool?.inputSchema.required).toContain("expected_sha");
  });

  it("guides a client with the old delete schema to a SHA-bound retry without deleting", async () => {
    const response = await callTool("delete", { source: "DS-my-strategy", path: "notes/a.md" }, "private");
    const result = response.result as { isError?: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      success: false,
      reason: "expected_sha_required",
    });
    expect(result.content[0].text).toContain("IWE-DELETE-SHA:");
    expect(deleteFromGitHub).not.toHaveBeenCalled();
  });

  it("accepts a confirmed SHA through the old schema's message field", async () => {
    const sha = "a".repeat(40);
    vi.mocked(deleteFromGitHub).mockResolvedValueOnce({ success: true });
    const response = await callTool("delete", {
      source: "DS-my-strategy",
      path: "notes/a.md",
      message: `IWE-DELETE-SHA:${sha}`,
    }, "private");
    expect((response.result as { isError?: boolean }).isError).toBeUndefined();
    expect(deleteFromGitHub).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), "DS-my-strategy", "notes/a.md",
      "Delete via Aisystant MCP", sha,
    );
  });

  it("refuses a malformed legacy SHA marker before calling the delete layer", async () => {
    const response = await callTool("delete", {
      source: "DS-my-strategy",
      path: "notes/a.md",
      message: "IWE-DELETE-SHA:short",
    }, "private");
    expect((response.result as { isError?: boolean }).isError).toBe(true);
    expect(deleteFromGitHub).not.toHaveBeenCalled();
  });

  it("advertises the private search implementation without changing the public catalog or accepted schema", async () => {
    const publicBefore = structuredClone(TOOLS);
    const request = { jsonrpc: "2.0", id: 1, method: "tools/list" } as const;
    const privateResponse = await handleMcpRequest(request, ENV, undefined, "private");
    const privateTools = (privateResponse.result as { tools: typeof TOOLS }).tools;
    const privateSearch = privateTools.find(tool => tool.name === "search")!;
    const publicSearch = TOOLS.find(tool => tool.name === "search")!;
    expect(privateSearch.description).toContain("personal sources");
    expect(privateSearch.description).toContain("32000 UTF-8 response bytes");
    expect(privateSearch.description).not.toMatch(/reranking|Pack entities|parent metadata/);
    expect(privateSearch.inputSchema.properties.source_type?.description).toContain("Ignored in private mode");
    expect(privateSearch.inputSchema.properties.limit?.description).toContain("clamped to 1..20");
    expect(privateSearch.inputSchema.properties.limit?.description).toContain("other values use 5");
    expect(privateSearch.inputSchema.properties.limit).toMatchObject({ minimum: 1, maximum: 20 });

    const withoutDescriptions = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(withoutDescriptions);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
          .filter(([key]) => key !== "description")
          .map(([key, entry]) => [key, withoutDescriptions(entry)]));
      }
      return value;
    };
    expect(withoutDescriptions(privateSearch.inputSchema)).toEqual(withoutDescriptions(publicSearch.inputSchema));
    expect(privateSearch.annotations).toEqual(publicSearch.annotations);
    const publicResponse = await handleMcpRequest(request, ENV, undefined, "public");
    expect(publicResponse.result).toEqual({ tools: publicBefore });
    expect(TOOLS).toEqual(publicBefore);
  });

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

  // WP-7 Ф117 regression: before the fix these two fell through to the public handler
  // (account_id IS NULL) and returned/leaked PUBLIC_LEAK.md instead of erroring OR
  // leaking, depending on whether the platform DSN happened to have the table — this
  // test pins the correct behavior (private-layer sentinel, public leak never touched).
  it("list_documents: private mode returns the personal-layer sentinel, not the public corpus", async () => {
    const res = await callTool("list_documents", {}, "private");
    const text = (res as { result: { content: [{ text: string }] } }).result.content[0].text;
    expect(text).toContain("PRIVATE_SENTINEL.md");
    expect(text).not.toContain("PUBLIC_LEAK.md");
    expect(personalListDocuments).toHaveBeenCalledTimes(1);
  });

  it("list_path: private mode returns the personal-layer sentinel, not the public corpus", async () => {
    const res = await callTool("list_path", {}, "private");
    const text = (res as { result: { content: [{ text: string }] } }).result.content[0].text;
    expect(text).toContain("PRIVATE_SENTINEL.md");
    expect(text).not.toContain("PUBLIC_LEAK.md");
    expect(personalListPath).toHaveBeenCalledTimes(1);
  });

  it("search: public mode never calls the personal-layer search function", async () => {
    await callTool("search", { query: "test" }, "public");
    expect(personalSearchDocuments).not.toHaveBeenCalled();
  });

  it("list_documents/list_path: public mode still returns the public corpus and never calls the personal-layer list functions", async () => {
    // Asserts actual response content, not just "didn't call the private function" — a
    // dispatch-only assertion would still pass if the public listPath()/listDocuments()
    // bodies themselves were broken (e.g. the WP-7 Ф117 refactor briefly left buildPathTree/
    // extractTitle out of scope in index.ts — caught by `tsc --noEmit`, not by a shallow test).
    // WP-7 Ф122: listDocuments/listPath (this exact code path — no unit test called them
    // directly before this) now also compute size_bytes; parse the JSON to check the real
    // value, not just that the string happens to contain it somewhere.
    const docsRes = await callTool("list_documents", {}, "public");
    const docsText = (docsRes as { result: { content: [{ text: string }] } }).result.content[0].text;
    const docsParsed = JSON.parse(docsText) as { filename: string; size_bytes: number }[];
    expect(docsParsed).toEqual([expect.objectContaining({ filename: "PUBLIC_LEAK.md", size_bytes: 21 })]);
    expect(personalListDocuments).not.toHaveBeenCalled();

    const pathRes = await callTool("list_path", {}, "public");
    const pathText = (pathRes as { result: { content: [{ text: string }] } }).result.content[0].text;
    const pathParsed = JSON.parse(pathText) as { path: string; size_bytes: number }[];
    expect(pathParsed).toEqual([expect.objectContaining({ path: "PUBLIC_LEAK.md", size_bytes: 21 })]);
    expect(personalListPath).not.toHaveBeenCalled();
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

  it("write: forwards expected_sha to the personal-layer write", async () => {
    const expectedSha = "a".repeat(40);
    vi.mocked(writeToGitHub).mockResolvedValueOnce({
      success: true,
      sha: "b".repeat(40),
      url: "https://github.com/TserenTserenov/DS-my-strategy/blob/main/docs/note.md",
    });

    await callTool("write", {
      source: "DS-my-strategy",
      path: "docs/note.md",
      content: "updated content",
      message: "Update with optimistic concurrency",
      expected_sha: expectedSha,
    }, "private");

    expect(writeToGitHub).toHaveBeenCalledTimes(1);
    expect(writeToGitHub).toHaveBeenCalledWith(
      ENV,
      expect.objectContaining({ userId: "user-private-1" }),
      "DS-my-strategy",
      "docs/note.md",
      "updated content",
      "Update with optimistic concurrency",
      {},
      expectedSha,
    );
  });

  // WP-7 Ф204: mode:'append' routes to the dedicated append path instead of writeToGitHub's
  // full-replace one — reachability through the dispatcher, same class of gap as the history
  // regression noted above (a correct appendToGitHub does not matter if nothing calls it).
  describe("write: mode 'append' (WP-7 Ф204)", () => {
    const expectedSha = "a".repeat(40);

    it("requires expected_sha before calling the personal layer at all", async () => {
      const res = await callTool("write", { source: "DS-my-strategy", path: "docs/note.md", content: "new line", mode: "append" }, "private") as
        { result: { content: [{ text: string }]; isError?: boolean } };
      expect(res.result.isError).toBe(true);
      expect(appendToGitHub).not.toHaveBeenCalled();
    });

    it("rejects an unknown on_conflict value before calling the personal layer", async () => {
      const res = await callTool("write", {
        source: "DS-my-strategy", path: "docs/note.md", content: "new line", mode: "append",
        expected_sha: expectedSha, on_conflict: "retry-forever",
      }, "private") as { result: { content: [{ text: string }]; isError?: boolean } };
      expect(res.result.isError).toBe(true);
      expect(appendToGitHub).not.toHaveBeenCalled();
    });

    it("rejects an unknown mode value", async () => {
      const res = await callTool("write", { source: "DS-my-strategy", path: "docs/note.md", content: "x", mode: "delete-everything" }, "private") as
        { result: { content: [{ text: string }]; isError?: boolean } };
      expect(res.result.isError).toBe(true);
      expect(writeToGitHub).not.toHaveBeenCalled();
      expect(appendToGitHub).not.toHaveBeenCalled();
    });

    // Codex cold review, round 15, High: content left the schema's `required` list when
    // str_replace was added (it must be absent for that mode) — this pins that mode:'replace'
    // still refuses a missing content instead of silently forwarding `undefined` to GitHub.
    it("still requires content for mode:'replace' (regression: content left the schema's required list)", async () => {
      const res = await callTool("write", { source: "DS-my-strategy", path: "docs/note.md" }, "private") as
        { result: { content: [{ text: string }]; isError?: boolean } };
      expect(res.result.isError).toBe(true);
      expect(writeToGitHub).not.toHaveBeenCalled();
    });

    it("rejects an empty or oversized operation_id before calling the personal layer", async () => {
      for (const operation_id of ["", "x".repeat(129)]) {
        const res = await callTool("write", {
          source: "DS-my-strategy", path: "docs/note.md", content: "x", mode: "append", expected_sha: expectedSha, operation_id,
        }, "private") as { result: { content: [{ text: string }]; isError?: boolean } };
        expect(res.result.isError).toBe(true);
      }
      expect(appendToGitHub).not.toHaveBeenCalled();
    });

    it("forwards content, expected_sha, on_conflict and operation_id to appendToGitHub, not writeToGitHub", async () => {
      vi.mocked(appendToGitHub).mockResolvedValueOnce({ success: true, sha: "b".repeat(40), retried: 0 });

      await callTool("write", {
        source: "DS-my-strategy", path: "docs/note.md", content: "new line", mode: "append",
        expected_sha: expectedSha, on_conflict: "retry", operation_id: "op-1",
      }, "private");

      expect(writeToGitHub).not.toHaveBeenCalled();
      expect(appendToGitHub).toHaveBeenCalledTimes(1);
      expect(appendToGitHub).toHaveBeenCalledWith(
        ENV,
        expect.objectContaining({ userId: "user-private-1" }),
        "DS-my-strategy",
        "docs/note.md",
        "new line",
        "Update via Aisystant MCP",
        expectedSha,
        { onConflict: "retry", operationId: "op-1" },
      );
    });

    it("returns appendToGitHub's result shape verbatim, including retried and idempotent_replay", async () => {
      vi.mocked(appendToGitHub).mockResolvedValueOnce({ success: true, sha: "b".repeat(40), retried: 2, idempotent_replay: true });

      const res = await callTool("write", {
        source: "DS-my-strategy", path: "docs/note.md", content: "new line", mode: "append", expected_sha: expectedSha,
      }, "private") as { result: { content: [{ text: string }] } };

      expect(JSON.parse(res.result.content[0].text)).toMatchObject({ success: true, retried: 2, idempotent_replay: true });
    });
  });

  describe("write: mode 'str_replace' (WP-7 Ф204)", () => {
    const expectedSha = "a".repeat(40);

    it("requires expected_sha before calling the personal layer at all", async () => {
      const res = await callTool("write", { source: "DS-my-strategy", path: "docs/note.md", mode: "str_replace", old_string: "a", new_string: "b" }, "private") as
        { result: { content: [{ text: string }]; isError?: boolean } };
      expect(res.result.isError).toBe(true);
      expect(strReplaceInGitHub).not.toHaveBeenCalled();
    });

    it("requires a non-empty old_string", async () => {
      const res = await callTool("write", { source: "DS-my-strategy", path: "docs/note.md", mode: "str_replace", old_string: "", new_string: "b", expected_sha: expectedSha }, "private") as
        { result: { content: [{ text: string }]; isError?: boolean } };
      expect(res.result.isError).toBe(true);
      expect(strReplaceInGitHub).not.toHaveBeenCalled();
    });

    it("requires new_string to be present (even if empty)", async () => {
      const res = await callTool("write", { source: "DS-my-strategy", path: "docs/note.md", mode: "str_replace", old_string: "a", expected_sha: expectedSha }, "private") as
        { result: { content: [{ text: string }]; isError?: boolean } };
      expect(res.result.isError).toBe(true);
      expect(strReplaceInGitHub).not.toHaveBeenCalled();
    });

    it("rejects a non-boolean dry_run", async () => {
      const res = await callTool("write", {
        source: "DS-my-strategy", path: "docs/note.md", mode: "str_replace", old_string: "a", new_string: "b", expected_sha: expectedSha, dry_run: "yes",
      }, "private") as { result: { content: [{ text: string }]; isError?: boolean } };
      expect(res.result.isError).toBe(true);
      expect(strReplaceInGitHub).not.toHaveBeenCalled();
    });

    it("forwards old_string, new_string, expected_sha, on_conflict, operation_id and dry_run to strReplaceInGitHub, not writeToGitHub or appendToGitHub", async () => {
      vi.mocked(strReplaceInGitHub).mockResolvedValueOnce({ success: true, sha: "b".repeat(40), retried: 0 });

      await callTool("write", {
        source: "DS-my-strategy", path: "docs/note.md", mode: "str_replace",
        old_string: "old", new_string: "new", expected_sha: expectedSha, on_conflict: "retry", operation_id: "op-1", dry_run: true,
      }, "private");

      expect(writeToGitHub).not.toHaveBeenCalled();
      expect(appendToGitHub).not.toHaveBeenCalled();
      expect(strReplaceInGitHub).toHaveBeenCalledTimes(1);
      expect(strReplaceInGitHub).toHaveBeenCalledWith(
        ENV,
        expect.objectContaining({ userId: "user-private-1" }),
        "DS-my-strategy",
        "docs/note.md",
        "old",
        "new",
        "Update via Aisystant MCP",
        expectedSha,
        { onConflict: "retry", operationId: "op-1", dryRun: true },
      );
    });

    it("returns strReplaceInGitHub's result shape verbatim, including fragment_ambiguous and matching_lines", async () => {
      vi.mocked(strReplaceInGitHub).mockResolvedValueOnce({ success: false, reason: "fragment_ambiguous", matching_lines: [3, 9], error: "ambiguous" });

      const res = await callTool("write", {
        source: "DS-my-strategy", path: "docs/note.md", mode: "str_replace", old_string: "old", new_string: "new", expected_sha: expectedSha,
      }, "private") as { result: { content: [{ text: string }] } };

      expect(JSON.parse(res.result.content[0].text)).toMatchObject({ success: false, reason: "fragment_ambiguous", matching_lines: [3, 9] });
    });

    it("ignores a stray content argument for mode:'str_replace' instead of letting it affect the call", async () => {
      vi.mocked(strReplaceInGitHub).mockResolvedValueOnce({ success: true, sha: "b".repeat(40) });

      await callTool("write", {
        source: "DS-my-strategy", path: "docs/note.md", mode: "str_replace",
        content: "this should be ignored", old_string: "old", new_string: "new", expected_sha: expectedSha,
      }, "private");

      expect(strReplaceInGitHub).toHaveBeenCalledWith(
        ENV, expect.objectContaining({ userId: "user-private-1" }), "DS-my-strategy", "docs/note.md",
        "old", "new", "Update via Aisystant MCP", expectedSha, { onConflict: undefined, operationId: undefined, dryRun: false },
      );
    });
  });

  // WP-7 Ф176 cold-review finding (26.09): "history" was schema-declared (tools/list
  // advertised it) but missing from PRIVATE_TOOL_NAMES, so the dispatch branch below —
  // gated behind PRIVATE_TOOL_NAMES.has(toolName) — never ran; every real call returned
  // "Unknown tool" despite personal.test.ts's unit tests for personalGetDocumentHistory
  // itself passing (that file never goes through the dispatcher). This is the same class
  // of gap the Ф117 list_documents/list_path regression above already exists to catch —
  // dispatch reachability, not just the called function's own correctness.
  it("history: private mode reaches the personal-layer commit history lookup", async () => {
    const res = await callTool("history", { source: "DS-my-strategy", path: "notes/idea.md" }, "private") as
      { result: { content: [{ text: string }] } };
    expect(res.result.content[0].text).toContain("PRIVATE_SENTINEL commit");
    expect(personalGetDocumentHistory).toHaveBeenCalledTimes(1);
    expect(personalGetDocumentHistory).toHaveBeenCalledWith(
      ENV, expect.objectContaining({ userId: "user-private-1" }), "DS-my-strategy", "notes/idea.md", undefined,
    );
  });

  it("get_document: ref forces the live sha-aware read, not the index-backed lookup", async () => {
    const res = await callTool("get_document", { filename: "notes/idea.md", ref: "a".repeat(40) }, "private") as
      { result: { content: [{ text: string }] } };
    expect(JSON.parse(res.result.content[0].text)).toMatchObject({ content: "private note content", sha: "a".repeat(40) });
    expect(personalGetDocumentWithSha).toHaveBeenCalledTimes(1);
    expect(personalGetDocument).not.toHaveBeenCalled();
  });

  it("get_document: rejects an empty-string ref before reaching the personal layer", async () => {
    // GitHub's Contents API treats ?ref= (empty) as "no ref" and returns the
    // default-branch file — not an error — so this must be caught before ever
    // calling into the layer that would talk to GitHub (cold-review finding,
    // verify session 26.09; the earlier attempt at this fix silently passed
    // an empty ref through, unobserved by any test).
    const res = await callTool("get_document", { filename: "notes/idea.md", ref: "" }, "private") as
      { result: { content: [{ text: string }]; isError?: boolean } };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("ref");
    expect(personalGetDocumentWithSha).not.toHaveBeenCalled();
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

  it("refuses the personal secret with 503 when private mode isn't configured on this deploy", async () => {
    // reindexEnv carries no MCP_MODE/DATABASE_URL/REINDEX_QUEUE — this is the public-worker
    // deploy shape, which never has a personal corpus to enqueue into (WP-545 Ф13).
    const res = await worker.fetch(reindexRequest("personal-secret"), reindexEnv);
    expect(res.status).toBe(503);
    const body = await res.json() as { reason: string };
    expect(body.reason).toBe("personal_reindex_unavailable");
  });

  it("fails closed with 503 when both secrets are configured equal (callers indistinguishable)", async () => {
    const equalEnv = { ...reindexEnv, PERSONAL_REINDEX_SECRET: "platform-secret" } as import("./index.js").Env;
    const res = await worker.fetch(reindexRequest("platform-secret"), equalEnv);
    expect(res.status).toBe(503);
    const body = await res.json() as { reason: string };
    expect(body.reason).toBe("reindex_secrets_not_distinguishable");
  });

  it("still lets the platform secret through to the platform indexer", async () => {
    const res = await worker.fetch(reindexRequest("platform-secret"), reindexEnv);
    expect(res.status).toBe(200);
    const body = await res.json() as { chunks: { status: string; reason: string; errors: string[] } };
    // Guard passed and reached reindexFiles — an unregistered source is a clean skip now
    // (WP-545 Ф13), not a partial-failure `errors` entry: the webhook fans every push to this
    // endpoint, including personal "DS-*" repos this worker was never meant to index.
    expect(body.chunks.status).toBe("skipped");
    expect(body.chunks.reason).toBe("unknown_platform_source");
    expect(body.chunks.errors).toEqual([]);
  });

  it("still refuses a wrong secret with 401", async () => {
    const res = await worker.fetch(reindexRequest("wrong"), reindexEnv);
    expect(res.status).toBe(401);
  });

  describe("personal branch (WP-545 Ф13 — private-mode deploy)", () => {
    const privateReindexEnv = {
      ...reindexEnv,
      MCP_MODE: "private",
      DATABASE_URL: "postgres://fake",
      REINDEX_QUEUE: { sendBatch: vi.fn() },
    } as unknown as import("./index.js").Env;

    function personalRequest(body: Record<string, unknown>) {
      return new Request("https://x/reindex", {
        method: "POST",
        headers: { Authorization: "Bearer personal-secret", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("requires user_id", async () => {
      const res = await worker.fetch(personalRequest({ source: "DS-my-strategy", files: [{ path: "a.md", action: "modified" }] }), privateReindexEnv);
      expect(res.status).toBe(400);
      const body = await res.json() as { reason: string };
      expect(body.reason).toBe("user_id_required");
    });

    it("skips a push with no indexable files without needing a DB or queue call", async () => {
      const res = await worker.fetch(personalRequest({
        source: "DS-my-strategy",
        files: [{ path: "image.png", action: "modified" }],
        user_id: "user-private-1",
      }), privateReindexEnv);
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string; reason: string };
      expect(body).toMatchObject({ status: "skipped", reason: "no_indexable_files" });
      expect(vi.mocked(privateReindexEnv.REINDEX_QUEUE!.sendBatch)).not.toHaveBeenCalled();
    });
  });
});

describe("/reindex-full and /provision-bridge-scopes (WP-545 Ф5, ported from personal-knowledge-mcp)", () => {
  const serviceEnv = {
    ...ENV,
    INTERNAL_SERVICE_SECRET: "service-secret",
    PERSONAL_REINDEX_SECRET: "personal-secret",
    INDICATORS_DATABASE_URL: "postgres://fake-indicators",
  } as import("./index.js").Env;

  function postJson(path: string, secret: string, body: Record<string, unknown>) {
    return new Request(`https://x${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // A fake neon() client for a single mockImplementationOnce call — resolves `rows`
  // for every query (or rejects with `rejectWith`), same tagged-template shape as the
  // top-level neon() mock. Cast through `unknown` because the real NeonQueryFunction
  // type carries `.query`/`.transaction` this fake intentionally doesn't implement.
  function fakeSql(rows: unknown[], rejectWith?: Error): ReturnType<typeof neon> {
    const tagged = (..._args: unknown[]) => (rejectWith ? Promise.reject(rejectWith) : Promise.resolve(rows));
    const sql = tagged as unknown as { unsafe: (v: string) => string };
    sql.unsafe = (v: string) => v;
    return tagged as unknown as ReturnType<typeof neon>;
  }

  it("/reindex-full rejects a missing token with 401", async () => {
    const req = new Request("https://x/reindex-full", { method: "POST", body: "{}" });
    const res = await worker.fetch(req, serviceEnv);
    expect(res.status).toBe(401);
  });

  it("/reindex-full rejects a service secret without user_id with 400", async () => {
    const res = await worker.fetch(postJson("/reindex-full", "service-secret", { source: "DS-my-strategy" }), serviceEnv);
    expect(res.status).toBe(400);
    const body = await res.json() as { reason: string };
    expect(body.reason).toBe("user_id_required_for_service_auth");
  });

  it("/reindex-full reaches startReindexJob for INTERNAL_SERVICE_SECRET (the historical personal-tree contract)", async () => {
    const res = await worker.fetch(
      postJson("/reindex-full", "service-secret", { source: "DS-my-strategy", user_id: "user-1" }),
      serviceEnv
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; message: string };
    // No REINDEX_QUEUE bound in this env — proves the request reached startReindexJob,
    // not that a queue message was actually sent.
    expect(body.status).toBe("failed");
    expect(body.message).toContain("REINDEX_QUEUE binding missing");
  });

  it("/reindex-full also accepts PERSONAL_REINDEX_SECRET — the secret github-integration-service actually sends", async () => {
    const res = await worker.fetch(
      postJson("/reindex-full", "personal-secret", { source: "DS-my-strategy", user_id: "user-1" }),
      serviceEnv
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("failed"); // same REINDEX_QUEUE-missing path as above
  });

  it("/reindex-full rejects a wrong secret with 401 when no ORY_URL is configured", async () => {
    const noOryEnv = { ...serviceEnv, ORY_URL: undefined } as import("./index.js").Env;
    const res = await worker.fetch(
      postJson("/reindex-full", "wrong", { source: "DS-my-strategy", user_id: "user-1" }),
      noOryEnv
    );
    expect(res.status).toBe(401);
  });

  it("/provision-bridge-scopes rejects a missing token with 401", async () => {
    const req = new Request("https://x/provision-bridge-scopes", { method: "POST", body: "{}" });
    const res = await worker.fetch(req, serviceEnv);
    expect(res.status).toBe(401);
  });

  it("/provision-bridge-scopes refuses an unowned source with 403 after auth succeeds", async () => {
    // The mocked Neon client returns [] for every query, including the ownership
    // SELECT — proves the route reaches the ownership gate, not just auth.
    const res = await worker.fetch(
      postJson("/provision-bridge-scopes", "service-secret", { source: "DS-my-strategy", user_id: "user-1" }),
      serviceEnv
    );
    expect(res.status).toBe(403);
    const body = await res.json() as { reason: string };
    expect(body.reason).toBe("source_not_owned");
  });

  it("/provision-bridge-scopes provisions scopes for an owned source", async () => {
    // Override the NEXT neon() call only (the ownership SELECT inside personalDb(env))
    // to return a row — everything else (including provisionBridgeScopes' own INSERT)
    // still gets the default []-returning client, which is fine: INSERT ... ON
    // CONFLICT doesn't need a return value to succeed.
    vi.mocked(neon).mockImplementationOnce(() => fakeSql([{ "?column?": 1 }]));

    const res = await worker.fetch(
      postJson("/provision-bridge-scopes", "service-secret", { source: "DS-my-strategy", user_id: "user-1" }),
      serviceEnv
    );
    // Regression guard (WP-545 Ф5 hotfix, found live 31.08): the ownership check must
    // hit the PERSONAL database (DATABASE_URL, where user_sources actually lives), not
    // the shared knowledge database (KNOWLEDGE_DATABASE_URL) — a prior version silently
    // used the wrong one, threw `relation "knowledge.user_sources" does not exist` on
    // every real call, and this test still passed because mockImplementationOnce
    // resolves for whichever DSN calls neon() first regardless of which one it is.
    expect(neon).toHaveBeenCalledWith(serviceEnv.DATABASE_URL);
    expect(neon).not.toHaveBeenCalledWith(serviceEnv.KNOWLEDGE_DATABASE_URL);
    expect(res.status).toBe(200);
    const body = await res.json() as { scope_provisioning: string; source: string; user_id: string };
    expect(body.scope_provisioning).toBe("ok");
    expect(body.source).toBe("DS-my-strategy");
    expect(body.user_id).toBe("user-1");
  });

  it("/provision-bridge-scopes never leaks the raw provisioning error to the client", async () => {
    vi.mocked(neon)
      .mockImplementationOnce(() => fakeSql([{ "?column?": 1 }])) // ownership SELECT — owned
      // provisionBridgeScopes' own INSERT — throws with a message that must never
      // reach the client (could carry SQL/table names).
      .mockImplementationOnce(() => fakeSql([], new Error("relation agent_scopes_mvp does not exist")));

    const res = await worker.fetch(
      postJson("/provision-bridge-scopes", "service-secret", { source: "DS-my-strategy", user_id: "user-1" }),
      serviceEnv
    );
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    expect(bodyText).not.toContain("agent_scopes_mvp");
    const body = JSON.parse(bodyText) as { scope_provisioning: string; error?: string };
    expect(body.scope_provisioning).toBe("failed");
    expect(body.error).toBeUndefined();
  });

  it("/reindex-full returns 400 on malformed JSON instead of throwing", async () => {
    const req = new Request("https://x/reindex-full", {
      method: "POST",
      headers: { Authorization: "Bearer service-secret", "Content-Type": "application/json" },
      body: "{not valid json",
    });
    const res = await worker.fetch(req, serviceEnv);
    expect(res.status).toBe(400);
    const body = await res.json() as { reason: string };
    expect(body.reason).toBe("missing_source");
  });

  it("/provision-bridge-scopes returns 400 on malformed JSON instead of throwing", async () => {
    const req = new Request("https://x/provision-bridge-scopes", {
      method: "POST",
      headers: { Authorization: "Bearer service-secret", "Content-Type": "application/json" },
      body: "{not valid json",
    });
    const res = await worker.fetch(req, serviceEnv);
    expect(res.status).toBe(400);
    const body = await res.json() as { reason: string };
    expect(body.reason).toBe("missing_source");
  });
});


describe("private read contract", () => {
  const syntheticDoc = { filename: "notes/bounds.md", source: "DS-my-strategy", source_type: "ds",
    github_url: null, content: '😀Яe\u0301\r\n"\\'.repeat(8_000) };
  const toolResult = (response: Awaited<ReturnType<typeof callTool>>) =>
    response.result as { content: { text: string }[]; isError?: boolean };
  const parsed = (response: Awaited<ReturnType<typeof callTool>>) => JSON.parse(toolResult(response).content[0].text);
  const bounded = (response: unknown) => expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThanOrEqual(32_000);

  it("advertises cursor only on the private document definition without mutating the public catalog", async () => {
    const before = JSON.stringify(TOOLS);
    const response = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ENV, undefined, "private");
    const tools = (response.result as { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] }).tools;
    expect(tools.find(tool => tool.name === "get_document")?.inputSchema.properties.cursor).toMatchObject({ type: "string", maxLength: 512 });
    expect(TOOLS.find(tool => tool.name === "get_document")?.inputSchema.properties).not.toHaveProperty("cursor");
    expect(JSON.stringify(TOOLS)).toBe(before);
  });

  it.each([[undefined, 5], [null, 5], ["200", 5], [Infinity, 5], [-1, 1], [0, 1], [2.8, 2], [200, 20]])(
    "normalizes dispatch limit %j before invoking the private data layer", async (limit, expected) => {
      const response = await callTool("search", { query: "notes", limit }, "private");
      expect(personalSearchDocuments).toHaveBeenCalledWith(ENV, expect.objectContaining({ userId: "user-private-1" }),
        "notes", undefined, expected);
      expect(parsed(response)[0].filename).toBe("PRIVATE_SENTINEL.md");
    });

  it("returns every selected search hit and degradation within the final serialized budget", async () => {
    const hits = Array.from({ length: 20 }, (_, i) => ({ ...syntheticDoc, filename: `note-${i}.md`, score: 1 - i / 100 }));
    const diagnostic = new ReadFailure("dependency_access_denied", "embeddings", 403).toJSON();
    vi.mocked(personalSearchDocuments).mockResolvedValueOnce(Object.assign(hits, { degradation: diagnostic }));
    const response = await callTool("search", { query: "notes", limit: 20 }, "private");
    bounded(response);
    expect(parsed(response).map((hit: { filename: string }) => hit.filename)).toEqual(hits.map(hit => hit.filename));
    expect(parsed(response).every((hit: { content_truncated: boolean }) => hit.content_truncated)).toBe(true);
    expect(JSON.parse(toolResult(response).content[1].text).diagnostic).toEqual(diagnostic);
  });

  it.each([false, true])("refuses oversized legacy documents before partial success (live=%s)", async live => {
    if (live) vi.mocked(personalGetDocumentWithSha).mockResolvedValueOnce({ ...syntheticDoc, kind: "document", sha: "a".repeat(40) });
    else vi.mocked(personalGetDocument).mockResolvedValueOnce(syntheticDoc);
    const response = await callTool("get_document", { filename: syntheticDoc.filename, include_sha: live }, "private");
    bounded(response);
    expect(toolResult(response).isError).toBe(true);
    expect(parsed(response).error).toBe("response_too_large");
  });

  it("reauthenticates each page, resolves omitted source consistently and returns the exact indexed representation", async () => {
    const authenticate = vi.spyOn(FakeJwtScopeGuard.prototype, "authenticate");
    let cursor: string | null = "start";
    let combined = "";
    let calls = 0;
    try {
      do {
        vi.mocked(personalGetDocument).mockResolvedValueOnce(syntheticDoc);
        const response = await callTool("get_document", { filename: syntheticDoc.filename, cursor,
          ...(calls ? { source: syntheticDoc.source, format: "full" } : {}) }, "private");
        bounded(response);
        expect(toolResult(response).isError).toBeUndefined();
        const page = parsed(response);
        expect(page).toMatchObject({ content_scope: "indexed_representation", read_mode: "indexed" });
        combined += page.content;
        cursor = page.next_cursor;
        expect(++calls).toBeLessThan(50);
      } while (cursor);
      expect(combined).toBe(syntheticDoc.content);
      expect(calls).toBeGreaterThan(1);
      expect(authenticate).toHaveBeenCalledTimes(calls);
      expect(resolveUserContext).toHaveBeenCalledTimes(calls);
      expect(personalGetDocument).toHaveBeenCalledTimes(calls);
      for (const [, context] of vi.mocked(personalGetDocument).mock.calls) expect(context.userId).toBe("user-private-1");
    } finally { authenticate.mockRestore(); }
  });

  it("selects a live file from current arguments and refuses a cursor after a different user authenticates", async () => {
    const liveDoc = { ...syntheticDoc, kind: "document" as const, sha: "a".repeat(40) };
    vi.mocked(personalGetDocumentWithSha).mockResolvedValueOnce(liveDoc);
    const first = await callTool("get_document", { filename: syntheticDoc.filename, source: syntheticDoc.source,
      include_sha: true, ref: "pinned-ref", cursor: "start" }, "private");
    const cursor = parsed(first).next_cursor;
    expect(parsed(first)).toMatchObject({ read_mode: "live", content_scope: "full_file", ref: "pinned-ref", sha: liveDoc.sha });
    const authenticate = vi.spyOn(FakeJwtScopeGuard.prototype, "authenticate").mockResolvedValueOnce({ userId: "user-private-2" });
    vi.mocked(resolveUserContext).mockResolvedValueOnce({ userId: "user-private-2", sources: [], sourceNames: [] });
    vi.mocked(personalGetDocumentWithSha).mockResolvedValueOnce(liveDoc);
    try {
      const next = await callTool("get_document", { filename: syntheticDoc.filename, source: syntheticDoc.source,
        include_sha: true, ref: "pinned-ref", cursor }, "private");
      expect(resolveUserContext).toHaveBeenLastCalledWith(ENV, "user-private-2");
      expect(personalGetDocumentWithSha).toHaveBeenLastCalledWith(ENV, expect.objectContaining({ userId: "user-private-2" }),
        syntheticDoc.filename, syntheticDoc.source, "pinned-ref");
      expect(parsed(next).error).toBe("invalid_cursor");
      expect(toolResult(next).isError).toBe(true);
      bounded(next);
    } finally { authenticate.mockRestore(); }
  });

  it.each([{ cursor: "bad" }, { cursor: "start", format: "headings" }, { cursor: "start", ref: "" }])(
    "rejects invalid paging arguments before reading document content: %j", async args => {
      const response = await callTool("get_document", { filename: syntheticDoc.filename, ...args }, "private");
      expect(toolResult(response).isError).toBe(true);
      expect(personalGetDocument).not.toHaveBeenCalled();
      expect(personalGetDocumentWithSha).not.toHaveBeenCalled();
      bounded(response);
    });

  it("does not call authentication or storage for an id too large to echo safely", async () => {
    const authenticate = vi.spyOn(FakeJwtScopeGuard.prototype, "authenticate");
    try {
      const response = await handleMcpRequest({ jsonrpc: "2.0", id: "名".repeat(40_000), method: "tools/call",
        params: { name: "get_document", arguments: { filename: syntheticDoc.filename } } }, ENV, undefined, "private",
      new Request("https://x/mcp"));
      expect(response).toMatchObject({ id: null, error: { code: -32600 } });
      expect(authenticate).not.toHaveBeenCalled();
      expect(resolveUserContext).not.toHaveBeenCalled();
      expect(personalGetDocument).not.toHaveBeenCalled();
      bounded(response);
    } finally { authenticate.mockRestore(); }
  });

  it.each(["ambiguous index", "ambiguous live", "source required", "ref hint", "dependency"] as const)(
    "bounds a large pre-pagination failure: %s", async scenario => {
      const long = "synthetic-".repeat(8_000);
      let args: Record<string, unknown> = { filename: syntheticDoc.filename, cursor: "start" };
      if (scenario === "ambiguous index") vi.mocked(personalGetDocument).mockRejectedValueOnce(new AmbiguousSourceError([long]));
      if (scenario === "ambiguous live") {
        args.include_sha = true;
        vi.mocked(personalGetDocumentWithSha).mockRejectedValueOnce(new AmbiguousSourceError([long]));
      }
      if (scenario === "source required") {
        args.include_sha = true;
        vi.mocked(personalGetDocumentWithSha).mockResolvedValueOnce({ kind: "source_required", sources: [long] });
      }
      if (scenario === "ref hint") {
        args.ref = long;
        vi.mocked(personalGetDocumentWithSha).mockResolvedValueOnce(null);
      }
      if (scenario === "dependency") vi.mocked(personalGetDocument).mockRejectedValueOnce(new ReadFailure("dependency_unavailable", "database"));
      const response = await callTool("get_document", args, "private");
      bounded(response);
      expect(toolResult(response).isError).toBe(true);
      expect(JSON.stringify(response)).not.toContain(long);
      expect(parsed(response).error).toBe(scenario === "dependency" ? "dependency_unavailable" : "response_too_large");
    });

  it("honors headings without returning the document body", async () => {
    vi.mocked(personalGetDocument).mockResolvedValueOnce({
      filename: "note.md", content: "# First\nPRIVATE BODY\n## Second", source: "DS-my-strategy", source_type: "ds", github_url: null,
    });
    const result = await callTool("get_document", { filename: "note.md", source: "DS-my-strategy", format: "headings" }, "private") as { result: {content: [{text: string}]} };
    // line/offset are additive (WP-7 Ф204, section selector) — existing level/title consumers are unaffected.
    expect(JSON.parse(result.result.content[0].text)).toEqual({ filename: "note.md", headings: [
      { level: 1, title: "First", line: 1, offset: 0 },
      { level: 2, title: "Second", line: 3, offset: 21 },
    ] });
    expect(result.result.content[0].text).not.toContain("PRIVATE BODY");
  });

  // WP-7 Ф204: end-to-end wiring for the three selectors added this session — the unit-level
  // byte-budget mechanics are covered in personal-response-bounds.test.ts; here we check that
  // index.ts resolves `section` against the real document and reports the right MCP error shape.
  describe("tail_lines and section (WP-7 Ф204)", () => {
    const withSections = { filename: "list.md", source: "DS-my-strategy", source_type: "ds", github_url: null,
      content: "# Intro\nnot kept\n## Tasks\n- a\n- b\n## Diary\nkept out" };

    it("returns the section body bounded to its heading, excluding siblings", async () => {
      vi.mocked(personalGetDocument).mockResolvedValueOnce(withSections);
      const response = await callTool("get_document", { filename: withSections.filename, section: "Tasks" }, "private");
      bounded(response);
      expect(toolResult(response).isError).toBeUndefined();
      expect(parsed(response).content).toBe("## Tasks\n- a\n- b\n");
    });

    it("reports section_not_found with the outline instead of guessing", async () => {
      vi.mocked(personalGetDocument).mockResolvedValueOnce(withSections);
      const response = await callTool("get_document", { filename: withSections.filename, section: "Nope" }, "private");
      expect(toolResult(response).isError).toBe(true);
      expect(parsed(response)).toMatchObject({ error: "section_not_found" });
      expect(parsed(response).headings.map((h: { title: string }) => h.title)).toEqual(["Intro", "Tasks", "Diary"]);
    });

    it("reports section_ambiguous with line numbers instead of picking one", async () => {
      vi.mocked(personalGetDocument).mockResolvedValueOnce({ ...withSections, content: "## Same\na\n## Same\nb" });
      const response = await callTool("get_document", { filename: withSections.filename, section: "Same" }, "private");
      expect(toolResult(response).isError).toBe(true);
      expect(parsed(response)).toMatchObject({ error: "section_ambiguous", matches: [{ level: 2, line: 1 }, { level: 2, line: 3 }] });
    });

    it("does not treat a heading-shaped line inside a fenced code block or frontmatter as a section", async () => {
      const withNoise = { ...withSections, content: "---\n# not a heading\n---\n```\n## Tasks\n```\n## Tasks\nreal body" };
      vi.mocked(personalGetDocument).mockResolvedValueOnce(withNoise);
      const response = await callTool("get_document", { filename: withNoise.filename, section: "Tasks" }, "private");
      expect(toolResult(response).isError).toBeUndefined();
      expect(parsed(response).content).toBe("## Tasks\nreal body");
    });

    // Kimi + Codex cold review, round 8: a naive toggle-on-any-fence-line parser misreads a
    // fenced block that contains a DIFFERENT fence character, or a shorter one of the SAME
    // character, as already closed — CommonMark only closes on the same character, length >= opener.
    it("does not close an outer fence on a shorter or differently-charactered nested fence", async () => {
      const nested = { ...withSections, content: "````markdown\n```python\n## not real\n```\n~~~\n## also not real\n~~~\n````\n## Tasks\nreal body" };
      vi.mocked(personalGetDocument).mockResolvedValueOnce(nested);
      const response = await callTool("get_document", { filename: nested.filename, section: "Tasks" }, "private");
      expect(toolResult(response).isError).toBeUndefined();
      expect(parsed(response).content).toBe("## Tasks\nreal body");
    });

    it("does not treat a 4-space-indented fence marker as a real fence (CommonMark indented code)", async () => {
      // Four leading spaces make this an indented code block, not a fence — so the heading-shaped
      // line right after it is NOT inside a fence and IS a real section.
      const indented = { ...withSections, content: "para\n    ```\n## Tasks\nreal body" };
      vi.mocked(personalGetDocument).mockResolvedValueOnce(indented);
      const response = await callTool("get_document", { filename: indented.filename, section: "Tasks" }, "private");
      expect(toolResult(response).isError).toBeUndefined();
      expect(parsed(response).content).toBe("## Tasks\nreal body");
    });

    it("finds headings in a file that starts with '---' but never closes it (thematic break, not frontmatter)", async () => {
      const noClose = { ...withSections, content: "---\nintro text, no closing dashes anywhere\n## Tasks\nreal body" };
      vi.mocked(personalGetDocument).mockResolvedValueOnce(noClose);
      const response = await callTool("get_document", { filename: noClose.filename, section: "Tasks" }, "private");
      expect(toolResult(response).isError).toBeUndefined();
      expect(parsed(response).content).toBe("## Tasks\nreal body");
    });

    it("finds the section that runs to the end of the file when no later heading exists", async () => {
      const last = { ...withSections, content: "# Intro\n## Tasks\n- a\n- b" };
      vi.mocked(personalGetDocument).mockResolvedValueOnce(last);
      const response = await callTool("get_document", { filename: last.filename, section: "Tasks" }, "private");
      expect(toolResult(response).isError).toBeUndefined();
      expect(parsed(response).content).toBe("## Tasks\n- a\n- b");
    });

    // Kimi cold review, round 9: documentHeadings' heading/fence/frontmatter regexes all operate
    // per-line; JS `.`/`$` do not cross a trailing \r, so a CRLF file (Windows-authored notes, a
    // realistic case for personal files) previously matched NO headings at all, not just corrupted
    // titles as first suspected — confirmed empirically before fixing, not by inspection alone.
    it("finds sections and exact offsets in a CRLF file the same as in an LF one", async () => {
      const crlf = { ...withSections, content: "# Intro\r\nnot kept\r\n## Tasks\r\n- a\r\n- b\r\n## Diary\r\nkept out" };
      vi.mocked(personalGetDocument).mockResolvedValueOnce(crlf);
      const response = await callTool("get_document", { filename: crlf.filename, section: "Tasks" }, "private");
      expect(toolResult(response).isError).toBeUndefined();
      expect(parsed(response).content).toBe("## Tasks\r\n- a\r\n- b\r\n");
    });

    it("strips an ATX heading's optional closing run of # characters from the title", async () => {
      const closed = { ...withSections, content: "## Tasks ##\nbody" };
      vi.mocked(personalGetDocument).mockResolvedValueOnce(closed);
      const response = await callTool("get_document", { filename: closed.filename, section: "Tasks" }, "private");
      expect(toolResult(response).isError).toBeUndefined();
      expect(parsed(response).content).toBe("## Tasks ##\nbody");
    });

    it("recognizes a heading indented up to 3 spaces, same CommonMark tolerance as fences (Kimi, round 10)", async () => {
      const indentedHeading = { ...withSections, content: "para\n   ## Tasks\nbody" };
      vi.mocked(personalGetDocument).mockResolvedValueOnce(indentedHeading);
      const response = await callTool("get_document", { filename: indentedHeading.filename, section: "Tasks" }, "private");
      expect(toolResult(response).isError).toBeUndefined();
      expect(parsed(response).content).toBe("   ## Tasks\nbody");
    });

    it("rejects a whitespace-only section title instead of silently matching nothing useful", async () => {
      const response = await callTool("get_document", { filename: withSections.filename, section: "   " }, "private");
      expect(toolResult(response).isError).toBe(true);
      expect(parsed(response).error).toBe("invalid_arguments");
    });

    it("paginates a section through the real handler via next_cursor, bounded to the section", async () => {
      const big = { ...withSections, content: "# Intro\nbefore\n## Tasks\n" + "x".repeat(60_000) + "\n## Diary\nafter" };
      vi.mocked(personalGetDocument).mockResolvedValue(big);
      let cursor: string | null = null;
      let combined = "";
      let pages = 0;
      do {
        const response = await callTool("get_document", cursor
          ? { filename: big.filename, cursor }
          : { filename: big.filename, section: "Tasks" }, "private");
        bounded(response);
        const page = parsed(response);
        combined += page.content;
        cursor = page.next_cursor;
        expect(++pages).toBeLessThan(20);
      } while (cursor);
      const sectionText = big.content.slice(big.content.indexOf("## Tasks"), big.content.indexOf("## Diary"));
      expect(combined).toBe(sectionText);
      expect(combined).not.toContain("after");
      expect(pages).toBeGreaterThan(1);
    });

    it("works through a live read (include_sha) the same way as indexed", async () => {
      vi.mocked(personalGetDocumentWithSha).mockResolvedValueOnce({ ...withSections, kind: "document", sha: "a".repeat(40) });
      const response = await callTool("get_document", { filename: withSections.filename, section: "Tasks", include_sha: true }, "private");
      expect(toolResult(response).isError).toBeUndefined();
      expect(parsed(response)).toMatchObject({ content: "## Tasks\n- a\n- b\n", sha: "a".repeat(40) });
    });

    it("returns the last requested lines through the real handler, live and indexed", async () => {
      vi.mocked(personalGetDocument).mockResolvedValueOnce({ ...withSections, content: "a\nb\nc" });
      const indexedResponse = await callTool("get_document", { filename: withSections.filename, tail_lines: 2 }, "private");
      expect(parsed(indexedResponse)).toMatchObject({ content: "b\nc", lines_returned: 2 });

      vi.mocked(personalGetDocumentWithSha).mockResolvedValueOnce({ ...withSections, kind: "document", content: "a\nb\nc", sha: "a".repeat(40) });
      const liveResponse = await callTool("get_document", { filename: withSections.filename, tail_lines: 2, include_sha: true }, "private");
      expect(parsed(liveResponse)).toMatchObject({ content: "b\nc", lines_returned: 2, sha: "a".repeat(40) });
    });

    it("rejects tail_lines and section together with the same selector-exclusivity error as cursor", async () => {
      const response = await callTool("get_document", { filename: withSections.filename, tail_lines: 2, section: "Tasks" }, "private");
      expect(toolResult(response).isError).toBe(true);
      expect(parsed(response).error).toBe("invalid_arguments");
    });
  });
});


it("returns an explicit tool failure when the source context cannot be loaded", async () => {
  vi.mocked(resolveUserContext).mockRejectedValueOnce(new ReadFailure("source_context_unavailable", "context"));
  const result = await callTool("get_document", { filename: "note.md" }, "private") as { result: {isError: boolean; content: [{text:string}]} };
  expect(result.result.isError).toBe(true);
  expect(JSON.parse(result.result.content[0].text).error).toBe("source_context_unavailable");
  expect(personalGetDocument).not.toHaveBeenCalled();
});

it.each([true, false])("preserves the semantic-search degradation notice (empty=%s)", async empty => {
  const rows = empty ? [] : [{ filename:"note.md", content:"keyword match", source:"DS-my-strategy",source_type:"ds",score:1,github_url:null }];
  vi.mocked(personalSearchDocuments).mockResolvedValueOnce(Object.assign(rows, {degradation:new ReadFailure("dependency_access_denied","embeddings",403).toJSON()}));
  const result = await callTool("search", { query:"find my notes" }, "private") as { result: {isError?: boolean;content:{text:string}[]} };
  expect(JSON.parse(result.result.content[0].text)).toEqual([...rows]);
  expect(result.result.content[1].text).toContain("Смысловой поиск недоступен");
  expect(result.result.isError === true).toBe(empty);
});
