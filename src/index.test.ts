import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectQueryType, resolveGithubUrl, hashQuery, rerankWithLLM, enrichWithParentContent, getEmbedding, searchDocuments, compactSearchResultsForResponse, buildSearchToolResponse, SEARCH_TOOL_RESPONSE_BUDGET_BYTES, normalizeSearchResultLimit, resolveDocument, normalizeDocumentLookupQuery, classifyDocumentResolution, handleMcpRequest, TOOLS, PRIVATE_TOOLS, PUBLIC_ONLY_TOOL_NAMES, WITHDRAWN_TOOL_MESSAGES, extractTitle, buildPathTree, checkFileSizeAdmission, partitionFilesBySize, SKILL_FILE_PATTERN, resolveScheduledJob, FULL_INGEST_SOURCES } from "./index.js";
import type { SearchResult, Env } from "./index.js";
import worker from "./index.js";
import { PRIVATE_TOOL_NAMES } from "./layers/private.js";
import { chunkLargeFile, contentHash } from "../scripts/ingest.js";
import { neon } from "@neondatabase/serverless";

vi.mock("@neondatabase/serverless", () => ({
  neon: vi.fn(),
  neonConfig: {},
  Pool: vi.fn(),
}));

// withUserContext mock — used by searchDocuments and enrichWithParentContent
type MockSql = ReturnType<typeof makeMockSql>;
type MockWithUserContextImpl = (fn: (sql: MockSql) => Promise<unknown>) => Promise<unknown>;

let mockWithUserContextImpl: MockWithUserContextImpl | null = null;
const mockPoolEnd = vi.fn().mockResolvedValue(undefined);

function makeMockSql(rows: unknown[]): (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]> {
  const sql = (() => Promise.resolve(rows)) as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>;
  (sql as any).unsafe = (value: string) => value;
  return sql;
}

vi.mock("./rls.js", () => ({
  createRequestPool: vi.fn(() => ({ end: mockPoolEnd })),
  withUserContext: vi.fn(async (_dsn: string, _userId: string | null | undefined, fn: (sql: unknown) => Promise<unknown>) => {
    if (mockWithUserContextImpl) return mockWithUserContextImpl(fn as any);
    return fn(makeMockSql([]) as unknown);
  }),
}));

beforeEach(() => {
  mockWithUserContextImpl = null;
  mockPoolEnd.mockClear();
});

// --- detectQueryType ---

describe("detectQueryType", () => {
  it("returns keyword for entity codes", () => {
    expect(detectQueryType("DP.AGENT.001")).toBe("keyword");
    expect(detectQueryType("MIM.M.003")).toBe("keyword");
    // SOTA.002 has only 2-char prefix + 1 segment — regex requires \w+\.\d+
    expect(detectQueryType("SOTA.S.002")).toBe("keyword");
    expect(detectQueryType("DP.IWE.002 §4a")).toBe("keyword");
  });

  it("returns keyword for short structured queries", () => {
    expect(detectQueryType("SPF.SPEC")).toBe("keyword");
  });

  it("returns vector for natural language queries", () => {
    expect(detectQueryType("как настроить систему подписок")).toBe("vector");
    expect(detectQueryType("what is the architecture of the platform")).toBe("vector");
    expect(detectQueryType("роли агентов в системе")).toBe("vector");
  });
});

describe("deterministic document resolver", () => {
  it("removes a course reference but preserves its human title and rejects a bare alias", () => {
    expect(normalizeDocumentLookupQuery("R1.1:7 — О системах, эпистемах и описаниях"))
      .toBe("О системах, эпистемах и описаниях");
    expect(normalizeDocumentLookupQuery("R1.1:7")).toBe("");
    expect(normalizeDocumentLookupQuery("DP.AGENT.001")).toBe("DP.AGENT.001");
    expect(normalizeDocumentLookupQuery("Ｒ1.1:7\u00a0—\u00a0  О системах"))
      .toBe("О системах");
  });

  it("does not query the database for an unresolvable bare course alias", async () => {
    await expect(resolveDocument(
      { KNOWLEDGE_DATABASE_URL: "postgres://example" } as Env,
      "R1.1:7",
    )).resolves.toEqual([]);
    expect(mockPoolEnd).not.toHaveBeenCalled();
  });

  it("returns only compact canonical document metadata", async () => {
    mockWithUserContextImpl = async () => [{
      filename: "professional/firefighting/02-identifying-describing-and-grounding-systems-effectively/09-systems-epistemes-and-descriptions.md",
      source: "docs-courses",
      source_type: "guides",
      title: "R1.1:7 - О системах, эпистемах и описаниях",
      score: 1,
    }];

    const results = await resolveDocument(
      { KNOWLEDGE_DATABASE_URL: "postgres://example" } as Env,
      "R1.1:7 — О системах, эпистемах и описаниях",
    );

    expect(results).toEqual([expect.objectContaining({
      filename: "professional/firefighting/02-identifying-describing-and-grounding-systems-effectively/09-systems-epistemes-and-descriptions.md",
      source: "docs-courses",
      title: "R1.1:7 - О системах, эпистемах и описаниях",
      score: 1,
    })]);
    expect(results[0]).not.toHaveProperty("content");
    expect(results[0].filename).not.toContain("::");
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);
  });

  it.each([
    "R9.9:9 — О системах, эпистемах и описаниях",
    "R1.1:7 — Другой материал",
    "R1.1:7x — О системах, эпистемах и описаниях",
    "RR1.1:7 — О системах, эпистемах и описаниях",
    "R1.1:7.0 — О системах, эпистемах и описаниях",
    "R1.1::7 — О системах, эпистемах и описаниях",
    "R1.1:7x",
    "R1-1:7 — О системах, эпистемах и описаниях",
    "R1/1:7 — О системах, эпистемах и описаниях",
    "R 1.1:7 — О системах, эпистемах и описаниях",
    "R1 .1:7 — О системах, эпистемах и описаниях",
    "R1.1 :7 — О системах, эпистемах и описаниях",
    "R1.1:7 —",
    "R2: Deep Reinforcement Learning",
    "Р1.1:7 — О системах, эпистемах и описаниях",
  ])("fails closed for an unknown or title-mismatched course reference: %s", async (query) => {
    await expect(resolveDocument(
      { KNOWLEDGE_DATABASE_URL: "postgres://example" } as Env,
      query,
    )).resolves.toEqual([]);
    expect(mockPoolEnd).not.toHaveBeenCalled();
  });

  it("does not let a source override redirect a curated course reference", async () => {
    await expect(resolveDocument(
      { KNOWLEDGE_DATABASE_URL: "postgres://example" } as Env,
      "R1.1:7 — О системах, эпистемах и описаниях",
      "FPF",
    )).resolves.toEqual([]);
    expect(mockPoolEnd).not.toHaveBeenCalled();
  });

  it("fails closed when a curated alias path no longer has its verified H1", async () => {
    mockWithUserContextImpl = async () => [{
      filename: "professional/firefighting/02-identifying-describing-and-grounding-systems-effectively/09-systems-epistemes-and-descriptions.md",
      source: "docs-courses",
      source_type: "guides",
      title: "Другой материал по переиспользованному пути",
      score: 1,
    }];

    await expect(resolveDocument(
      { KNOWLEDGE_DATABASE_URL: "postgres://example" } as Env,
      "R1.1:7 — О системах, эпистемах и описаниях",
    )).resolves.toEqual([]);
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);
  });

  it.each([{ bad: "source" }, 42])("rejects a non-string resolver source without throwing: %p", async (source) => {
    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "resolve_document", arguments: { query: "test", source } },
      },
      {} as Env,
    );
    expect(response.result).toEqual(expect.objectContaining({ isError: true }));
  });

  it("reads only an unambiguous high-confidence match", () => {
    const base = {
      filename: "target.md",
      source: "docs-courses",
      source_type: "guides",
      title: "Target",
      github_url: null,
    };
    // Production corpus check across all 2,095 docs-courses roots was 0.862
    // top-1 versus 0.593 runner-up; keep that observed safe separation.
    expect(classifyDocumentResolution([{ ...base, score: 0.862 }, { ...base, filename: "other.md", score: 0.593 }]))
      .toBe("resolved");
    expect(classifyDocumentResolution([{ ...base, score: 0.72 }, { ...base, filename: "other.md", score: 0.70 }]))
      .toBe("ambiguous");
    expect(classifyDocumentResolution([{ ...base, score: 0.66 }, { ...base, filename: "other.md", score: 0.64 }]))
      .toBe("ambiguous");
    expect(classifyDocumentResolution([{ ...base, score: 0.64 }])).toBe("not_found");
    expect(classifyDocumentResolution([])).toBe("not_found");
  });

  it("registers resolve_document as a read-only tool", () => {
    const tool = TOOLS.find((candidate) => candidate.name === "resolve_document");
    expect(tool).toBeDefined();
    expect(tool?.annotations).toEqual(expect.objectContaining({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    }));
  });

  it("does not expose or route the platform resolver in private mode", async () => {
    const listed = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      {} as Env,
      undefined,
      "private",
    );
    const tools = (listed.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.some(tool => tool.name === "resolve_document")).toBe(false);

    const called = await handleMcpRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "resolve_document", arguments: { query: "test" } } },
      {} as Env,
      undefined,
      "private",
    );
    expect(called.error).toEqual(expect.objectContaining({ code: -32601 }));
  });
});

describe("public-only tools in private mode (WP-7 Ф183)", () => {
  const PUBLIC_ONLY = ["resolve_document", "feedback", "feedback_stats"];
  // Публичные имена, которым разрешено оставаться в private tools/list: личные
  // реализации (Ф117) + live-подтверждённые рабочие на личной базе (Ф183).
  // Любое иное публичное имя здесь — регрессия (непроверенный обработчик с
  // доступом к платформенным таблицам), тест обязан упасть.
  const ALLOWED_PUBLIC_IN_PRIVATE = [
    "search", "get_document", "list_sources", "list_documents", "list_path",
    "analyze_verbalization", "graph_stats", "learner_progress",
    "concept_status", "concept_search_by_name", "concept_expand", "pack_traverse",
    "load_skill",
  ];

  async function listToolNames(mode: "public" | "private"): Promise<string[]> {
    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      {} as Env,
      undefined,
      mode,
    );
    return (res.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
  }

  it.each(PUBLIC_ONLY)("%s is hidden from private tools/list and refused with -32601", async (name) => {
    expect(await listToolNames("private")).not.toContain(name);

    const called = await handleMcpRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: {} } },
      {} as Env,
      undefined,
      "private",
    );
    expect(called.error).toEqual(expect.objectContaining({ code: -32601 }));
  });

  it("private tools/list carries only verified public names plus private tools", async () => {
    const names = await listToolNames("private");
    const allowed = new Set([...ALLOWED_PUBLIC_IN_PRIVATE, ...PRIVATE_TOOLS.map((tool) => tool.name)]);
    expect([...names].sort()).toEqual([...allowed].sort());
  });

  it("does not apply the private withdrawal to the public tools/list", async () => {
    const names = await listToolNames("public");
    for (const name of PUBLIC_ONLY) expect(names).toContain(name);
  });

  // Public mode must reach each withdrawn tool's own handler. The env carries mock
  // DSNs so the feedback handlers finish against the mocked DB layer. Every row
  // expects a different, handler-specific outcome, so a mis-routed dispatch cannot
  // pass by returning an error shared with another handler.
  it.each<[string, Record<string, unknown>, string]>([
    ["feedback", { document_id: 7, query: "q", helpfulness: true }, '{"recorded":false}'],
    ["feedback_stats", {}, "[]"],
    ["resolve_document", {}, "invalid resolve_document arguments"],
  ])("routes %s to its own handler in public mode", async (name, args, marker) => {
    const env = { KNOWLEDGE_DATABASE_URL: "mock-knowledge-dsn", HEALTH_DATABASE_URL: "mock-health-dsn" } as unknown as Env;
    const called = await handleMcpRequest(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } },
      env,
      undefined,
      "public",
    );
    expect(called.error).toBeUndefined();
    const text = (called.result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain(marker);
  });

  // The tests above pass the mode to handleMcpRequest directly. This block goes
  // through the worker's HTTP entry point, where the mode comes from env.MCP_MODE.
  describe("via the worker HTTP entry point", () => {
    async function postMcp(mcpMode: string, body: object): Promise<Response> {
      const request = new Request("https://knowledge.test/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return worker.fetch(request, { MCP_MODE: mcpMode } as unknown as Env);
    }

    async function httpToolNames(mcpMode: string): Promise<string[]> {
      const res = await postMcp(mcpMode, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { result: { tools: Array<{ name: string }> } };
      return payload.result.tools.map((tool) => tool.name);
    }

    it("MCP_MODE=private hides the withdrawn tools and refuses a direct call with -32601", async () => {
      const names = await httpToolNames("private");
      for (const name of PUBLIC_ONLY) expect(names).not.toContain(name);

      const res = await postMcp("private", {
        jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "feedback", arguments: {} },
      });
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { error?: { code: number } };
      expect(payload.error?.code).toBe(-32601);
    });

    it("MCP_MODE=public does not apply the private withdrawal", async () => {
      const names = await httpToolNames("public");
      for (const name of PUBLIC_ONLY) expect(names).toContain(name);
    });

    it("an invalid MCP_MODE fails closed with HTTP 500", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const res = await postMcp("bogus", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      expect(res.status).toBe(500);
      errorSpy.mockRestore();
    });
  });
});

// --- WP-7 F186: reindex_source is withdrawn in every mode ---

describe("withdrawn tools (WP-7 F186)", () => {
  const WITHDRAWN = "reindex_source";
  const MODES = ["public", "private"] as const;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function listNames(mode: "public" | "private"): Promise<string[]> {
    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      {} as Env,
      undefined,
      mode,
    );
    return (res.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
  }

  it.each(MODES)("%s tools/list does not offer the withdrawn tool", async (mode) => {
    expect(await listNames(mode)).not.toContain(WITHDRAWN);
  });

  // Pins the two policy sets exactly: a name added to either one by mistake, or
  // reindex_source slipping back into the private-mode set, fails here (the global
  // refusal runs first, so no behavioural test could notice the second case).
  it("the policy sets hold exactly the intended names", () => {
    expect([...PUBLIC_ONLY_TOOL_NAMES].sort()).toEqual(["feedback", "feedback_stats", "resolve_document"]);
    expect([...WITHDRAWN_TOOL_MESSAGES.keys()]).toEqual([WITHDRAWN]);
  });

  it("the tool is gone from both static tool tables", () => {
    expect(TOOLS.map((tool) => tool.name)).not.toContain(WITHDRAWN);
    expect(PRIVATE_TOOLS.map((tool) => tool.name)).not.toContain(WITHDRAWN);
  });

  // Every argument shape and caller identity gets the same refusal, and nothing
  // downstream runs: no GitHub fetch and no database client.
  const CALLS: Array<[string, Record<string, unknown>, string | undefined]> = [
    ["a valid platform source", { source: "docs-courses" }, undefined],
    ["dry_run", { source: "docs-courses", dry_run: true }, undefined],
    ["explicit files", { source: "docs-courses", files: ["a.md"] }, undefined],
    ["a signed-in user id", { source: "docs-courses" }, "user-1"],
    ["no arguments", {}, undefined],
  ];

  it.each(MODES.flatMap((mode) => CALLS.map(([label, args, userId]) => [mode, label, args, userId] as const)))(
    "%s: refuses %s with -32601 and touches nothing",
    async (mode, _label, args, userId) => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;
      const dbSpy = vi.fn();
      mockWithUserContextImpl = async (fn) => {
        dbSpy();
        return fn(makeMockSql([]));
      };
      vi.mocked(neon).mockClear();

      const called = await handleMcpRequest(
        { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: WITHDRAWN, arguments: args } },
        { OPENROUTER_API_KEY: "test-key", KNOWLEDGE_DATABASE_URL: "mock-knowledge-dsn" } as unknown as Env,
        userId,
        mode,
      );

      expect(called.error).toEqual(expect.objectContaining({ code: -32601 }));
      expect(String(called.error?.message)).toContain("withdrawn");
      expect(called.result).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(dbSpy).not.toHaveBeenCalled();
      expect(vi.mocked(neon)).not.toHaveBeenCalled();
    },
  );

  // The tests above pass the mode to handleMcpRequest directly. This block goes
  // through the worker's HTTP entry point, with credentials attached.
  describe("via the worker HTTP entry point", () => {
    async function postMcp(mcpMode: string, body: object): Promise<Response> {
      const request = new Request("https://knowledge.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer not-a-real-token",
          "x-user-id": "user-1",
        },
        body: JSON.stringify(body),
      });
      return worker.fetch(request, { MCP_MODE: mcpMode } as unknown as Env);
    }

    it.each(MODES)("MCP_MODE=%s: not listed, and a call with credentials is refused", async (mode) => {
      const listed = await postMcp(mode, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      expect(listed.status).toBe(200);
      const names = ((await listed.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);
      expect(names).not.toContain(WITHDRAWN);

      const res = await postMcp(mode, {
        jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: WITHDRAWN, arguments: { source: "docs-courses" } },
      });
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { error?: { code: number; message: string } };
      expect(payload.error?.code).toBe(-32601);
      expect(payload.error?.message).toContain("withdrawn");
    });
  });

  // The replacement path must stay reachable. This only shows the route is still there
  // and fails closed (401 with a secret configured, 503 without); it does not exercise
  // the authorized path into reindexFiles().
  it("the POST /reindex route is still present and fails closed", async () => {
    const post = (env: object) =>
      worker.fetch(new Request("https://knowledge.test/reindex", { method: "POST", body: "{}" }), env as unknown as Env);
    expect((await post({ REINDEX_SECRET: "test-reindex-secret" })).status).toBe(401);
    expect((await post({})).status).toBe(503);
  });
});

describe("compact search response", () => {
  it("caps repeated document bodies before MCP serialization", () => {
    const huge = "Ф".repeat(8_000_000);
    const compacted = compactSearchResultsForResponse([{
      id: 1,
      filename: "FPF.md::chunk",
      source: "FPF",
      source_type: "pack",
      score: 0.9,
      github_url: null,
      content: huge,
      parent_filename: "FPF.md",
      parent_content: huge,
    }]);

    expect(compacted[0].content.length).toBeLessThan(2_100);
    expect(compacted[0].parent_content?.length).toBeLessThan(2_100);
    expect(compacted[0].content).toContain("use get_document");
    expect(JSON.stringify(compacted).length).toBeLessThan(5_000);
  });

  it("bounds requested result counts before any database fetch", () => {
    expect(normalizeSearchResultLimit(0)).toBe(1);
    expect(normalizeSearchResultLimit(5)).toBe(5);
    expect(normalizeSearchResultLimit(100)).toBe(20);
    expect(normalizeSearchResultLimit(Number.NaN)).toBe(5);
  });

  it("fits the complete Cyrillic JSON-RPC search response by UTF-8 bytes", () => {
    const huge = "Ф".repeat(8_000_000);
    const results = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      filename: `FPF-${index}.md::chunk`,
      source: "FPF",
      source_type: "pack",
      score: 0.9 - index / 100,
      github_url: null,
      content: huge,
      parent_filename: `FPF-${index}.md`,
      parent_content: huge,
    }));

    const response = buildSearchToolResponse(7, results);
    const serialized = JSON.stringify(response);
    expect(new TextEncoder().encode(serialized).length)
      .toBeLessThanOrEqual(SEARCH_TOOL_RESPONSE_BUDGET_BYTES);

    const content = (response.result as { content: Array<{ text: string }> }).content[0].text;
    const decoded = JSON.parse(content) as Array<{ content: string; parent_content?: string }>;
    expect(decoded).toHaveLength(20);
    expect(decoded[0].content).toContain("use get_document");
    expect(decoded[0].parent_content).toContain("use get_document");
  });
});

// --- resolveGithubUrl ---

describe("resolveGithubUrl", () => {
  it("returns correct URL for known source", () => {
    const url = resolveGithubUrl("PACK-digital-platform", "digital-platform/02-domain-entities/DP.AGENT.001.md");
    expect(url).toContain("github.com/MimEcoSys/PACK-digital-platform");
    expect(url).toContain("pack/digital-platform/02-domain-entities/DP.AGENT.001.md");
  });

  it("strips chunk suffix from filename", () => {
    const url = resolveGithubUrl("FPF", "FPF-Spec.md::B.1.3 - Section");
    expect(url).toContain("FPF-Spec.md");
    expect(url).not.toContain("::");
  });

  it("returns null for unknown source", () => {
    expect(resolveGithubUrl("unknown-source", "file.md")).toBeNull();
  });
});

// --- checkFileSizeAdmission (WP-532, 2026-09-02 — reindexFiles() silently
// dropped files >100_000 chars before the large-file chunking branch could
// ever run; extracted so the admission policy is testable without DB/GitHub
// mocks) ---
describe("checkFileSizeAdmission", () => {
  it("admits content at or under the limit", () => {
    expect(checkFileSizeAdmission(1_000_000)).toBeNull();
    expect(checkFileSizeAdmission(801_500)).toBeNull(); // representative affected DPF Suite file
  });

  it("rejects content over the limit with a reason mentioning the limit", () => {
    const reason = checkFileSizeAdmission(1_000_001);
    expect(reason).not.toBeNull();
    expect(reason).toContain("1000000");
  });
});

// --- partitionFilesBySize (WP-532, 2026-09-02 — pre-filter for syncFullIngestSource(),
// so a daily full-ingest pass doesn't spend a GitHub fetch on files it already knows are
// too big for checkFileSizeAdmission()) ---
describe("partitionFilesBySize", () => {
  it("splits files under and over the byte limit", () => {
    const files = [
      { path: "small.md", size: 500 },
      { path: "big.md", size: 2_000_000 },
    ];
    const { eligible, excluded } = partitionFilesBySize(files, 1_000_000);
    expect(eligible.map((f) => f.path)).toEqual(["small.md"]);
    expect(excluded.map((f) => f.path)).toEqual(["big.md"]);
  });

  it("treats a file exactly at the limit as eligible (matches checkFileSizeAdmission's own boundary — rejects only strictly over)", () => {
    const files = [{ path: "boundary.md", size: 1_000_000 }];
    const { eligible, excluded } = partitionFilesBySize(files, 1_000_000);
    expect(eligible).toHaveLength(1);
    expect(excluded).toHaveLength(0);
  });

  it("excludes a file one byte over the limit", () => {
    const files = [{ path: "over-by-one.md", size: 1_000_001 }];
    const { eligible, excluded } = partitionFilesBySize(files, 1_000_000);
    expect(eligible).toHaveLength(0);
    expect(excluded).toHaveLength(1);
  });

  it("returns empty arrays for empty input", () => {
    expect(partitionFilesBySize([], 1_000_000)).toEqual({ eligible: [], excluded: [] });
  });
});

// --- SKILL_FILE_PATTERN (WP-560 Ф11 — the narrow filter that keeps
// rebuildSkillsIndex() from ever handing reindexFiles() anything but SKILL.md
// files, satisfying the ArchGate condition that the 15-min cron must not touch
// the rest of FMT-exocortex-template's index) ---
describe("SKILL_FILE_PATTERN", () => {
  it("matches a top-level skill's SKILL.md", () => {
    expect(SKILL_FILE_PATTERN.test(".claude/skills/ke/SKILL.md")).toBe(true);
  });

  it("matches a skill name containing digits and hyphens", () => {
    expect(SKILL_FILE_PATTERN.test(".claude/skills/day-open-2/SKILL.md")).toBe(true);
  });

  it("rejects a file inside a skill's own subdirectory (e.g. its scripts/)", () => {
    expect(SKILL_FILE_PATTERN.test(".claude/skills/ke/scripts/run.sh")).toBe(false);
  });

  it("rejects a nested SKILL.md one level too deep", () => {
    expect(SKILL_FILE_PATTERN.test(".claude/skills/ke/sub/SKILL.md")).toBe(false);
  });

  it("rejects files outside .claude/skills/ entirely", () => {
    expect(SKILL_FILE_PATTERN.test("docs/some-guide.md")).toBe(false);
    expect(SKILL_FILE_PATTERN.test(".claude/rules/formatting.md")).toBe(false);
  });

  it("rejects SKILL.md with no skill-name directory", () => {
    expect(SKILL_FILE_PATTERN.test(".claude/skills/SKILL.md")).toBe(false);
  });
});

// --- FULL_INGEST_SOURCES (WP-532, peer-session 2026-09-29 — sources with no
// push-webhook, synced by syncFullIngestSource() on the daily cron instead;
// see the comment above this constant in index.ts for why each entry is here) ---
describe("FULL_INGEST_SOURCES", () => {
  it("covers FPF and SPF, and nothing else", () => {
    expect(FULL_INGEST_SOURCES).toEqual(["FPF", "SPF"]);
  });
});

// --- resolveScheduledJob (WP-560 Ф11, cold-review follow-up 2026-09-04) ---
// The pure decision scheduled() delegates to. A silent fallthrough here is the
// exact bug that nearly dropped the daily PACK/FPF heartbeat when the 15-min
// skills cron was added — this is the guard against it recurring.
describe("resolveScheduledJob", () => {
  it("routes private mode to the reindex watchdog regardless of cron", () => {
    expect(resolveScheduledJob("private", "*/15 * * * *")).toBe("watchdog");
    expect(resolveScheduledJob("private", "30 0 * * *")).toBe("watchdog");
  });

  it("routes the 15-minute public cron to the skills rebuild", () => {
    expect(resolveScheduledJob("public", "*/15 * * * *")).toBe("skills");
  });

  it("routes the daily public cron to the heartbeat, not the skills rebuild", () => {
    expect(resolveScheduledJob("public", "30 0 * * *")).toBe("heartbeat");
  });

  it("falls back to heartbeat, not silence, for any unrecognized public cron", () => {
    expect(resolveScheduledJob("public", "0 0 1 * *")).toBe("heartbeat");
  });
});

// --- extractTitle (WP-5 backlog #31 — list_path) ---

describe("extractTitle", () => {
  it("extracts the first H1 heading", () => {
    expect(extractTitle("# Digital Twin\n\nSome body text.")).toBe("Digital Twin");
  });

  it("finds H1 even when it is not the first line", () => {
    expect(extractTitle("---\ntype: doc\n---\n\n# Real Title\n\nBody.")).toBe("Real Title");
  });

  it("ignores H2+ headings when no H1 is present", () => {
    expect(extractTitle("## Section\n\nBody.")).toBeNull();
  });

  it("returns null for content without any heading", () => {
    expect(extractTitle("Just plain text, no headings at all.")).toBeNull();
  });

  it("trims surrounding whitespace from the extracted title", () => {
    expect(extractTitle("#   Spacey Title   \n")).toBe("Spacey Title");
  });
});

// --- buildPathTree (WP-5 backlog #31 — list_path) ---

describe("buildPathTree", () => {
  it("returns files as-is when within depth", () => {
    const docs = [
      { source: "PACK-x", path: "pack/README.md", title: "Readme" },
      { source: "PACK-x", path: "pack/index.md", title: "Index" },
    ];
    const tree = buildPathTree(docs, "pack/", 1);
    // localeCompare sort (human-friendly, case-insensitive-first) — not raw ASCII.
    expect(tree).toEqual([
      { type: "file", source: "PACK-x", path: "pack/index.md", title: "Index" },
      { type: "file", source: "PACK-x", path: "pack/README.md", title: "Readme" },
    ]);
  });

  it("collapses paths deeper than depth into a single dir entry", () => {
    const docs = [
      { source: "PACK-x", path: "pack/02-domain-entities/DP.AGENT.001.md", title: "Agent" },
      { source: "PACK-x", path: "pack/02-domain-entities/DP.AGENT.002.md", title: "Agent 2" },
      { source: "PACK-x", path: "pack/03-roles/DP.ROLE.001.md", title: "Role" },
    ];
    const tree = buildPathTree(docs, "pack/", 1);
    expect(tree).toEqual([
      { type: "dir", source: "PACK-x", path: "pack/02-domain-entities", title: null },
      { type: "dir", source: "PACK-x", path: "pack/03-roles", title: null },
    ]);
  });

  it("mixes files and collapsed dirs at the same level", () => {
    const docs = [
      { source: "PACK-x", path: "pack/README.md", title: "Readme" },
      { source: "PACK-x", path: "pack/02-domain-entities/DP.AGENT.001.md", title: "Agent" },
    ];
    const tree = buildPathTree(docs, "pack/", 1);
    expect(tree).toEqual([
      { type: "dir", source: "PACK-x", path: "pack/02-domain-entities", title: null },
      { type: "file", source: "PACK-x", path: "pack/README.md", title: "Readme" },
    ]);
  });

  it("dedupes multiple files under the same collapsed dir (same source)", () => {
    const docs = [
      { source: "PACK-x", path: "pack/a/one.md", title: "One" },
      { source: "PACK-x", path: "pack/a/two.md", title: "Two" },
      { source: "PACK-x", path: "pack/a/nested/three.md", title: "Three" },
    ];
    const tree = buildPathTree(docs, "pack/", 1);
    expect(tree).toEqual([{ type: "dir", source: "PACK-x", path: "pack/a", title: null }]);
  });

  it("does NOT merge same-named dirs across different sources (cold review High finding)", () => {
    const docs = [
      { source: "PACK-x", path: "pack/02-domain-entities/DP.AGENT.001.md", title: "Agent" },
      { source: "PACK-y", path: "pack/02-domain-entities/DP.OTHER.001.md", title: "Other" },
    ];
    const tree = buildPathTree(docs, "pack/", 1);
    expect(tree).toEqual([
      { type: "dir", source: "PACK-x", path: "pack/02-domain-entities", title: null },
      { type: "dir", source: "PACK-y", path: "pack/02-domain-entities", title: null },
    ]);
  });

  it("expands deeper when depth is increased", () => {
    const docs = [{ source: "PACK-x", path: "pack/02-domain-entities/DP.AGENT.001.md", title: "Agent" }];
    const tree = buildPathTree(docs, "pack/", 2);
    expect(tree).toEqual([
      { type: "file", source: "PACK-x", path: "pack/02-domain-entities/DP.AGENT.001.md", title: "Agent" },
    ]);
  });

  it("works with no path prefix (source root)", () => {
    const docs = [{ source: "PACK-x", path: "top-level.md", title: "Top" }];
    const tree = buildPathTree(docs, "", 1);
    expect(tree).toEqual([{ type: "file", source: "PACK-x", path: "top-level.md", title: "Top" }]);
  });

  it("clamps depth<=0 to 1 (function-level contract, independent of caller)", () => {
    const docs = [{ source: "PACK-x", path: "pack/a/b/deep.md", title: "Deep" }];
    const treeZero = buildPathTree(docs, "pack/", 0);
    const treeOne = buildPathTree(docs, "pack/", 1);
    expect(treeZero).toEqual(treeOne);
    expect(treeZero).toEqual([{ type: "dir", source: "PACK-x", path: "pack/a", title: null }]);
  });
});

// --- chunkLargeFile ---

describe("chunkLargeFile", () => {
  it("splits by ## headers", () => {
    const content = `# Title\n\n## Section A\n\nContent A\n\n## Section B\n\nContent B`;
    const chunks = chunkLargeFile(content, "test.md");
    expect(chunks.length).toBe(2);
    expect(chunks[0].filename).toBe("test.md::Section A");
    expect(chunks[1].filename).toBe("test.md::Section B");
  });

  it("includes breadcrumb prefix with document title", () => {
    const content = `# My Document\n\n## Section One\n\nSome content here`;
    const chunks = chunkLargeFile(content, "doc.md");
    // First chunk might be _intro (content before ##), second is the section
    const sectionChunk = chunks.find((c) => c.filename.includes("Section One"));
    expect(sectionChunk).toBeDefined();
    expect(sectionChunk!.content).toContain("> My Document > Section One");
  });

  it("handles content without ## headers gracefully", () => {
    // Single large block without headers — intro section
    const content = `# Title\n\n${"A".repeat(500)}`;
    const chunks = chunkLargeFile(content, "single.md");
    // May be 0 if intro < 10 chars after split, or 1 chunk
    expect(chunks.length).toBeGreaterThanOrEqual(0);
  });

  it("chunks content with parent filename format", () => {
    const content = `# Title\n\n## S1\n\nContent A here.\n\n## S2\n\nContent B here.`;
    const chunks = chunkLargeFile(content, "path/to/file.md");
    const s1 = chunks.find((c) => c.filename === "path/to/file.md::S1");
    expect(s1).toBeDefined();
  });
});

// --- contentHash ---

describe("contentHash", () => {
  it("returns consistent 16-char hex hash", () => {
    const hash = contentHash("test content");
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns same hash for same content", () => {
    expect(contentHash("hello")).toBe(contentHash("hello"));
  });

  it("returns different hash for different content", () => {
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });
});

// --- rerankWithLLM ---

function makeResult(overrides: Partial<SearchResult> & { id: number; score: number }): SearchResult {
  return {
    filename: `doc-${overrides.id}.md`,
    content: `Content of document ${overrides.id}`,
    source: "test",
    source_type: "pack",
    github_url: null,
    ...overrides,
  };
}

function mockFetchResponse(scores: { index: number; relevance_score: number }[]) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ scores }) } }],
    }),
  };
}

describe("rerankWithLLM", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns single result unchanged", async () => {
    const results = [makeResult({ id: 1, score: 0.8 })];
    const out = await rerankWithLLM("fake-key", "test query", results, 5);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(1);
  });

  it("reranks by hybrid score (vector 0.3 + LLM 0.7)", async () => {
    const results = [
      makeResult({ id: 1, score: 0.9 }), // high vector, low LLM
      makeResult({ id: 2, score: 0.5 }), // low vector, high LLM
    ];

    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse([
      { index: 0, relevance_score: 0.2 }, // id=1: 0.9*0.3 + 0.2*0.7 = 0.41
      { index: 1, relevance_score: 0.95 }, // id=2: 0.5*0.3 + 0.95*0.7 = 0.815
    ]));

    const out = await rerankWithLLM("fake-key", "test query", results, 5);
    expect(out[0].id).toBe(2); // LLM preferred doc-2
    expect(out[1].id).toBe(1);
    expect(out[0].score).toBeCloseTo(0.815, 2);
    expect(out[1].score).toBeCloseTo(0.41, 2);
  });

  it("respects limit parameter", async () => {
    const results = [
      makeResult({ id: 1, score: 0.9 }),
      makeResult({ id: 2, score: 0.8 }),
      makeResult({ id: 3, score: 0.7 }),
    ];

    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse([
      { index: 0, relevance_score: 0.9 },
      { index: 1, relevance_score: 0.8 },
      { index: 2, relevance_score: 0.7 },
    ]));

    const out = await rerankWithLLM("fake-key", "query", results, 2);
    expect(out).toHaveLength(2);
  });

  it("falls back to original order on fetch error", async () => {
    const results = [
      makeResult({ id: 1, score: 0.9 }),
      makeResult({ id: 2, score: 0.5 }),
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    const out = await rerankWithLLM("fake-key", "query", results, 5);
    expect(out[0].id).toBe(1);
    expect(out[0].score).toBe(0.9); // original scores preserved
  });

  it("falls back on network error (timeout/abort)", async () => {
    const results = [
      makeResult({ id: 1, score: 0.8 }),
      makeResult({ id: 2, score: 0.6 }),
    ];

    globalThis.fetch = vi.fn().mockRejectedValue(new Error("AbortError"));

    const out = await rerankWithLLM("fake-key", "query", results, 5);
    expect(out).toHaveLength(2);
    expect(out[0].score).toBe(0.8); // unchanged
  });

  it("handles missing LLM scores with default 0.5", async () => {
    const results = [
      makeResult({ id: 1, score: 0.9 }),
      makeResult({ id: 2, score: 0.4 }),
    ];

    // Only score for index 0, index 1 gets default 0.5
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse([
      { index: 0, relevance_score: 0.3 },
    ]));

    const out = await rerankWithLLM("fake-key", "query", results, 5);
    // id=1: 0.9*0.3 + 0.3*0.7 = 0.48
    // id=2: 0.4*0.3 + 0.5*0.7 = 0.47 (default 0.5)
    expect(out[0].id).toBe(1);
    expect(out[1].id).toBe(2);
  });

  it("handles array format response (not wrapped in {scores})", async () => {
    const results = [
      makeResult({ id: 1, score: 0.5 }),
      makeResult({ id: 2, score: 0.5 }),
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify([
          { index: 0, relevance_score: 0.3 },
          { index: 1, relevance_score: 0.9 },
        ]) } }],
      }),
    });

    const out = await rerankWithLLM("fake-key", "query", results, 5);
    expect(out[0].id).toBe(2); // higher LLM score wins
  });

  it("clamps LLM scores to 0-1 range", async () => {
    const results = [
      makeResult({ id: 1, score: 0.5 }),
      makeResult({ id: 2, score: 0.5 }),
    ];

    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse([
      { index: 0, relevance_score: 1.5 },  // should clamp to 1.0
      { index: 1, relevance_score: -0.3 }, // should clamp to 0.0
    ]));

    const out = await rerankWithLLM("fake-key", "query", results, 5);
    // id=1: 0.5*0.3 + 1.0*0.7 = 0.85
    // id=2: 0.5*0.3 + 0.0*0.7 = 0.15
    expect(out[0].score).toBeCloseTo(0.85, 2);
    expect(out[1].score).toBeCloseTo(0.15, 2);
  });

  it("falls back on empty choices", async () => {
    const results = [makeResult({ id: 1, score: 0.7 }), makeResult({ id: 2, score: 0.6 })];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [] }),
    });

    const out = await rerankWithLLM("fake-key", "query", results, 5);
    expect(out[0].score).toBe(0.7); // original
  });
});

// --- getEmbedding ---

function mockEmbeddingResponse(embedding: number[]) {
  return {
    ok: true,
    json: async () => ({ data: [{ embedding }] }),
  };
}

describe("getEmbedding", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns the embedding on first successful attempt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockEmbeddingResponse([0.1, 0.2, 0.3]));
    globalThis.fetch = fetchMock;

    const out = await getEmbedding("fake-key", "test query");
    expect(out).toEqual([0.1, 0.2, 0.3]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries once and succeeds when the first attempt fails", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce(mockEmbeddingResponse([0.4, 0.5, 0.6]));
    globalThis.fetch = fetchMock;

    const out = await getEmbedding("fake-key", "test query");
    expect(out).toEqual([0.4, 0.5, 0.6]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws after both attempts fail", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "server error" });
    globalThis.fetch = fetchMock;

    await expect(getEmbedding("fake-key", "test query")).rejects.toThrow("Embedding service unavailable after retry (http_5xx)");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("logs structured JSON for each failed HTTP attempt and carries status/requestId on the error (WP-7 Ф183)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const headers = new Map([["x-openrouter-request-id", "req-123"], ["cf-ray", "ray-456"]]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      headers: { get: (key: string) => headers.get(key) ?? null },
      text: async () => JSON.stringify({ error: { code: "forbidden", message: "key sk-secret-echo must not be logged" } }),
    });
    globalThis.fetch = fetchMock;

    const failure = await getEmbedding("fake-key", "test query").catch((error) => error);
    expect(failure.message).toBe("Embedding service unavailable after retry (http_4xx)");
    expect(failure.status).toBe(403);
    expect(failure.requestId).toBe("req-123");
    // Текст ошибки и лог не несут ни тело провайдера, ни эхо ключа.
    expect(failure.message).not.toContain("sk-secret-echo");

    expect(errorSpy).toHaveBeenCalledTimes(2);
    const first = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(first).toMatchObject({
      event: "embedding_http_error",
      provider: "openrouter",
      status: 403,
      statusText: "Forbidden",
      errorCategory: "http_4xx",
      attempt: 1,
      requestId: "req-123",
      cfRay: "ray-456",
      url: "https://openrouter.ai/api/v1/embeddings",
      errorCode: "forbidden",
    });
    expect(JSON.stringify(first)).not.toContain("sk-secret-echo");
    expect(JSON.parse(errorSpy.mock.calls[1][0] as string).attempt).toBe(2);
    errorSpy.mockRestore();
  });

  it("logs null errorCode for a non-JSON provider error body, keeping its length (WP-7 Ф183)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const body = `Bad gateway\n${"k".repeat(500)}`;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => body,
    });
    globalThis.fetch = fetchMock;

    await getEmbedding("fake-key", "test query").catch(() => {});
    const first = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(first.errorCode).toBeNull();
    expect(first.errorBodyLength).toBe(body.length);
    expect(JSON.stringify(first)).not.toContain("k".repeat(80));
    errorSpy.mockRestore();
  });

  it("drops provider-controlled fields that echo the apiKey or embedding input (WP-7 Ф183)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const apiKey = "sk-livekey-echo";
    const inputText = "secret-user-query-text-here";
    const headers = new Map([
      ["x-openrouter-request-id", apiKey],
      ["cf-ray", inputText.slice(0, 16)],
    ]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: { get: (key: string) => headers.get(key) ?? null },
      text: async () => JSON.stringify({ error: { code: apiKey } }),
    });
    globalThis.fetch = fetchMock;

    await getEmbedding(apiKey, inputText).catch(() => {});
    const first = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(first.requestId).toBeNull();
    expect(first.cfRay).toBeNull();
    expect(first.errorCode).toBeNull();
    const logged = JSON.stringify(first);
    expect(logged).not.toContain(apiKey);
    expect(logged).not.toContain(inputText.slice(0, 16));
    errorSpy.mockRestore();
  });

  // Shared setup for the leak tests below: one failed attempt whose provider-controlled
  // fields are set by the caller. Returns the parsed "embedding_http_error" record.
  const LEAK_INPUT = "secret-user-query-text-here";
  const LEAK_API_KEY = "sk-or-v1-0123456789abcdef012345"; // fake, kept under 40 chars so it does not look like a token

  async function logFailedEmbedding(opts: {
    headers?: Record<string, string>;
    body?: unknown;
    apiKey?: string;
    input?: string;
  }): Promise<Record<string, unknown>> {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const headers = new Map(Object.entries(opts.headers ?? {}));
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: { get: (key: string) => headers.get(key) ?? null },
      text: async () => JSON.stringify(opts.body ?? { error: { code: "forbidden" } }),
    });
    await getEmbedding(opts.apiKey ?? LEAK_API_KEY, opts.input ?? LEAK_INPUT).catch(() => {});
    const logged = JSON.parse(errorSpy.mock.calls[0][0] as string) as Record<string, unknown>;
    errorSpy.mockRestore();
    return logged;
  }

  it("keeps well-formed provider identifiers (guards against over-blocking)", async () => {
    const logged = await logFailedEmbedding({
      headers: { "x-openrouter-request-id": "gen-abc123xyz", "cf-ray": "8a1b2c3d4e5f6a7b-FRA" },
      body: { error: { code: 403 } },
    });
    expect(logged).toMatchObject({ requestId: "gen-abc123xyz", cfRay: "8a1b2c3d4e5f6a7b-FRA", errorCode: "403" });
  });

  // These two cases hand over a value that is itself a substring of the input, so the
  // substring rule catches them. They do NOT exercise the sliding window (see below).
  it("drops a field that is itself a fragment of the input (substring rule)", async () => {
    const logged = await logFailedEmbedding({
      headers: {
        // straddles the 16-char block boundary (offsets 8..24)
        "x-openrouter-request-id": LEAK_INPUT.slice(8, 24),
        // short fragment (<16 chars)
        "cf-ray": LEAK_INPUT.slice(0, 8),
      },
    });
    expect(logged.requestId).toBeNull();
    expect(logged.cfRay).toBeNull();
    expect(logged.errorCode).toBe("forbidden");
  });

  // Each row wraps a 16-char window of a secret in text that is NOT a substring of the
  // secret, so only the sliding-window rule can catch it. The scan slides over the value,
  // so what matters is where the shared run sits inside it: prefix "r" puts it at index 1,
  // which no scan step above 1 reaches; "req-" puts it at index 4. Removing the window
  // loop turns every row red.
  const carriers = {
    requestId: (value: string) => ({ headers: { "x-openrouter-request-id": value } }),
    cfRay: (value: string) => ({ headers: { "cf-ray": value } }),
    errorCode: (value: string) => ({ body: { error: { code: value } } }),
  } as const;
  const wrapWindow = (secret: string, from: number, prefix: string) => `${prefix}${secret.slice(from, from + 16)}-9`;

  it.each(
    (["requestId", "cfRay", "errorCode"] as const).flatMap((field) => [
      [field, "embedding input", LEAK_INPUT, 8, "r"] as const,
      [field, "embedding input", LEAK_INPUT, 8, "req-"] as const,
      [field, "API key", LEAK_API_KEY, 3, "r"] as const,
      [field, "API key", LEAK_API_KEY, 3, "req-"] as const,
    ]),
  )("drops %s that wraps a window of the %s", async (field, _secretName, secret, from, prefix) => {
    const value = wrapWindow(secret, from, prefix);
    expect(secret.includes(value)).toBe(false); // precondition: not a plain substring
    const logged = await logFailedEmbedding(carriers[field](value));
    expect(logged[field]).toBeNull();
    expect(JSON.stringify(logged)).not.toContain(secret.slice(from, from + 16));
  });

  // Pins the documented threshold from below; the 16-char rows above pin it from above.
  it("keeps a wrapper that shares one char fewer than the leak window with the input", async () => {
    const value = `req-${LEAK_INPUT.slice(8, 23)}-9`; // 15 shared chars
    const logged = await logFailedEmbedding(carriers.requestId(value));
    expect(logged.requestId).toBe(value);
  });

  it("drops a numeric error code whose text form leaves the allowed charset (1e100 -> 1e+100)", async () => {
    const logged = await logFailedEmbedding({ body: { error: { code: 1e100 } } });
    expect(logged.errorCode).toBeNull();
  });

  it("does not treat an empty API key as a match for every field", async () => {
    const logged = await logFailedEmbedding({
      apiKey: "",
      headers: { "x-openrouter-request-id": "gen-abc123xyz" },
    });
    expect(logged.requestId).toBe("gen-abc123xyz");
  });

  // A secret shorter than the window has no window to share: only the whole-value and
  // substring rules apply to it.
  it("catches a short secret by containment but not by partial overlap", async () => {
    const whole = await logFailedEmbedding({ apiKey: "fake-key", headers: { "x-openrouter-request-id": "req-fake-key-9" } });
    expect(whole.requestId).toBeNull();
    const partial = await logFailedEmbedding({ apiKey: "fake-key", headers: { "x-openrouter-request-id": "req-fake-ke-9" } });
    expect(partial.requestId).toBe("req-fake-ke-9");
  });

  it("still catches a wrapped window of a very long input", async () => {
    const input = `${"x".repeat(200_000)}tail-of-the-user-query`;
    const value = `req-${input.slice(-20, -4)}-9`;
    expect(input.includes(value)).toBe(false);
    const logged = await logFailedEmbedding({ input, headers: { "x-openrouter-request-id": value } });
    expect(logged.requestId).toBeNull();
  });
});

// --- searchDocuments embedding resilience ---

describe("searchDocuments embedding resilience", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns keyword results after both embedding attempts fail", async () => {
    const query = "как различать системы и их описания";
    const apiKey = "private-api-key";
    const providerBody = "provider diagnostic must stay private";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => providerBody,
    });
    globalThis.fetch = fetchMock;

    const keywordRow = {
      id: 17,
      filename: "about-systems.md",
      content: "Система не совпадает со своим описанием.",
      source: "docs-courses",
      source_type: "course",
      score: 0.9,
    };
    const rowBatches = [[keywordRow], []];
    let dbCall = 0;
    mockWithUserContextImpl = (fn) => fn(makeMockSql(rowBatches[dbCall++] ?? []));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const results = await searchDocuments(
      {
        KNOWLEDGE_DATABASE_URL: "postgres://knowledge",
        HEALTH_DATABASE_URL: "postgres://health",
        OPENROUTER_API_KEY: apiKey,
      },
      query,
      "docs-courses",
      undefined,
      5
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results).toEqual([{
      ...keywordRow,
      github_url: "https://github.com/MimEcoSys/docs/blob/main/docs/ru/about-systems.md",
    }]);
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logLine = warnSpy.mock.calls[0][0] as string;
    expect(JSON.parse(logLine)).toEqual({
      event: "knowledge_search_embedding_fallback",
      reason: "http_5xx",
      status: 503,
      request_id: null,
      embedding_attempts: 2,
      fallback: "keyword",
      source_filter_present: true,
      source_type_filter_present: false,
    });
    expect(logLine).not.toContain(query);
    expect(logLine).not.toContain(apiKey);
    expect(logLine).not.toContain(providerBody);
  });

  it("logs status and request id of the last attempt in the fallback record", async () => {
    const failure = (status: number, requestId: string) => ({
      ok: false,
      status,
      headers: { get: (key: string) => (key === "x-openrouter-request-id" ? requestId : null) },
      text: async () => "bad gateway",
    });
    // Different metadata per attempt: keeping the first attempt's would fail below.
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(failure(503, "req-first"))
      .mockResolvedValueOnce(failure(502, "req-last"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockWithUserContextImpl = (fn) => fn(makeMockSql([]));

    await searchDocuments(
      { KNOWLEDGE_DATABASE_URL: "mock-knowledge-dsn", HEALTH_DATABASE_URL: "mock-health-dsn", OPENROUTER_API_KEY: "private-api-key" },
      "how to tell systems from their descriptions",
      undefined,
      undefined,
      5,
    );

    const fallback = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(fallback).toMatchObject({ event: "knowledge_search_embedding_fallback", status: 502, request_id: "req-last" });
    // the same id appears in the per-attempt error record, so the two log lines can be joined
    const lastAttempt = JSON.parse(errorSpy.mock.calls[1][0] as string);
    expect(lastAttempt).toMatchObject({ event: "embedding_http_error", attempt: 2, requestId: "req-last" });
  });

  it("keeps the vector path when embedding succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockEmbeddingResponse([0.1, 0.2, 0.3]));
    globalThis.fetch = fetchMock;

    const vectorRow = {
      id: 21,
      filename: "semantic-result.md",
      content: "Результат семантического поиска.",
      source: "FPF",
      source_type: "spec",
      score: 0.88,
    };
    const rowBatches = [[vectorRow], []];
    let dbCall = 0;
    mockWithUserContextImpl = (fn) => fn(makeMockSql(rowBatches[dbCall++] ?? []));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const results = await searchDocuments(
      {
        KNOWLEDGE_DATABASE_URL: "postgres://knowledge",
        HEALTH_DATABASE_URL: "postgres://health",
        OPENROUTER_API_KEY: "api-key",
      },
      "как устроены системные уровни"
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({
      filename: "semantic-result.md",
      content: "Результат семантического поиска.",
      score: 0.88,
    });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);
  });

  it("does not mask database failures as embedding fallback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockEmbeddingResponse([0.1, 0.2, 0.3]));
    globalThis.fetch = fetchMock;
    mockWithUserContextImpl = async () => {
      throw new Error("database unavailable");
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(searchDocuments(
      {
        KNOWLEDGE_DATABASE_URL: "postgres://knowledge",
        HEALTH_DATABASE_URL: "postgres://health",
        OPENROUTER_API_KEY: "api-key",
      },
      "как устроены системные уровни"
    )).rejects.toThrow("database unavailable");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);
  });
});

// --- searchDocuments: empty vector result must still reach keyword search ---
// A legitimately empty ANN result (chunks without an embedding, or a narrow filter) used
// to skip keyword search entirely and return `[]` — the low-confidence fallback branch
// only fired for a NON-empty vector result. These tests pin the fallback.

describe("searchDocuments empty-vector keyword fallback", () => {
  const originalFetch = globalThis.fetch;
  const env = {
    KNOWLEDGE_DATABASE_URL: "postgres://knowledge",
    HEALTH_DATABASE_URL: "postgres://health",
    OPENROUTER_API_KEY: "private-api-key",
  };

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns keyword results when the vector query is empty but the embedding succeeded", async () => {
    const query = "мим мастер роль";
    const fetchMock = vi.fn().mockResolvedValue(mockEmbeddingResponse([0.1, 0.2, 0.3]));
    globalThis.fetch = fetchMock;

    const keywordRow = {
      id: 42,
      filename: "mim-master-role.md",
      content: "Роль мастера МИМ: ведёт группу по программе.",
      source: "docs-courses",
      source_type: "course",
      score: 0.9,
    };
    // DB call order: vectorSearch (empty) → keywordSearch (hit) → enrichWithParentContent.
    const rowBatches = [[], [keywordRow], []];
    let dbCall = 0;
    mockWithUserContextImpl = (fn) => fn(makeMockSql(rowBatches[dbCall++] ?? []));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const results = await searchDocuments(env, query, "docs-courses", undefined, 5);

    // Embedding fetched once; a single candidate never reaches the LLM reranker.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dbCall).toBe(3);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ filename: "mim-master-role.md", source: "docs-courses", score: 0.9 });
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logLine = warnSpy.mock.calls[0][0] as string;
    expect(JSON.parse(logLine)).toEqual({
      event: "knowledge_search_vector_empty",
      fallback: "keyword",
      keyword_result_count: 1,
      source_filter_present: true,
      source_type_filter_present: false,
    });
    expect(logLine).not.toContain(query);
    expect(logLine).not.toContain(env.OPENROUTER_API_KEY);
  });

  it("still returns [] when both vector and keyword find nothing, and says so in the log", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockEmbeddingResponse([0.1, 0.2, 0.3]));
    globalThis.fetch = fetchMock;
    let dbCall = 0;
    mockWithUserContextImpl = (fn) => { dbCall += 1; return fn(makeMockSql([])); };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const results = await searchDocuments(env, "как устроены системные уровни");

    expect(results).toEqual([]);
    // vectorSearch + keywordSearch; enrichWithParentContent short-circuits on empty input.
    expect(dbCall).toBe(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warnSpy.mock.calls[0][0] as string)).toMatchObject({
      event: "knowledge_search_vector_empty",
      keyword_result_count: 0,
    });
  });

  it("does not repeat keyword search for a keyword-typed query that already found nothing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockEmbeddingResponse([0.1, 0.2, 0.3]));
    globalThis.fetch = fetchMock;
    let dbCall = 0;
    mockWithUserContextImpl = (fn) => { dbCall += 1; return fn(makeMockSql([])); };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // Entity code → keyword-first path: keywordSearch (empty) → vectorSearch (empty) → stop.
    const results = await searchDocuments(env, "DP.D.053 §4");

    expect(results).toEqual([]);
    expect(dbCall).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// --- enrichWithParentContent ---

describe("enrichWithParentContent", () => {
  it("returns empty array for empty input", async () => {
    const env = { KNOWLEDGE_DATABASE_URL: "fake", HEALTH_DATABASE_URL: "fake", OPENROUTER_API_KEY: "fake" } as Env;
    const out = await enrichWithParentContent(env, []);
    expect(out).toEqual([]);
  });

  it("enriches chunks with parent content", async () => {
    const parentRows = [
      {
        chunk_filename: "doc.md::Section A",
        chunk_source: "PACK-digital-platform",
        parent_filename: "doc.md",
        parent_content: "Full parent document content here",
      },
    ];
    mockWithUserContextImpl = (fn) => fn(makeMockSql(parentRows) as any);

    const env = { KNOWLEDGE_DATABASE_URL: "postgres://fake", HEALTH_DATABASE_URL: "postgres://fake", OPENROUTER_API_KEY: "fake" } as Env;
    const results: SearchResult[] = [
      makeResult({ id: 10, score: 0.9, filename: "doc.md::Section A", source: "PACK-digital-platform" }),
      makeResult({ id: 11, score: 0.8, filename: "other.md", source: "SPF" }),
    ];

    const out = await enrichWithParentContent(env, results);

    expect(out[0].parent_filename).toBe("doc.md");
    expect(out[0].parent_content).toBe("Full parent document content here");
    // Second result has no parent
    expect(out[1].parent_filename).toBeUndefined();
    expect(out[1].parent_content).toBeUndefined();
    mockWithUserContextImpl = null;
  });

  it("handles no parent rows gracefully", async () => {
    mockWithUserContextImpl = (fn) => fn(makeMockSql([]) as any);

    const env = { KNOWLEDGE_DATABASE_URL: "postgres://fake", HEALTH_DATABASE_URL: "postgres://fake", OPENROUTER_API_KEY: "fake" } as Env;
    const results: SearchResult[] = [
      makeResult({ id: 5, score: 0.7, filename: "standalone.md", source: "SPF" }),
    ];

    const out = await enrichWithParentContent(env, results);
    expect(out[0].parent_filename).toBeUndefined();
    expect(out[0].filename).toBe("standalone.md");
    mockWithUserContextImpl = null;
  });
});

// --- hashQuery ---

describe("hashQuery", () => {
  it("returns consistent 64-char hex hash", async () => {
    const hash = await hashQuery("как настроить подписки");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns same hash for same query", async () => {
    const a = await hashQuery("test query");
    const b = await hashQuery("test query");
    expect(a).toBe(b);
  });

  it("returns different hash for different queries", async () => {
    const a = await hashQuery("query A");
    const b = await hashQuery("query B");
    expect(a).not.toBe(b);
  });
});

// --- TOOLS array includes feedback tools ---

describe("feedback tools registration", () => {
  it("feedback tool is registered with its required input fields", () => {
    const tool = TOOLS.find((t) => t.name === "feedback");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toEqual(["document_id", "query", "helpfulness"]);
  });

  it("feedback_stats tool is registered", () => {
    const tool = TOOLS.find((t) => t.name === "feedback_stats");
    expect(tool).toBeDefined();
  });
});

// --- TOOLS array includes list_path (WP-5 backlog #31) ---

describe("list_path tool registration", () => {
  it("list_path tool is registered with source/path_prefix/depth properties", () => {
    const tool = TOOLS.find((t) => t.name === "list_path");
    expect(tool).toBeDefined();
    expect(Object.keys(tool!.inputSchema.properties!)).toEqual(["source", "path_prefix", "depth"]);
  });

  it("does not duplicate list_documents (kept as a separate, unmodified tool)", () => {
    const listDocs = TOOLS.find((t) => t.name === "list_documents");
    expect(listDocs).toBeDefined();
    expect(listDocs!.inputSchema.properties).not.toHaveProperty("path_prefix");
  });
});

// WP-7 Ф176 cold-review finding (26.09): "history" was declared in PRIVATE_TOOLS'
// schema (so tools/list advertised it) but missing from PRIVATE_TOOL_NAMES — the
// dispatch handler in the tools/call branch below is gated behind
// PRIVATE_TOOL_NAMES.has(toolName), so every real call returned "Unknown tool"
// despite a green test suite. Nothing before this asserted the two lists agree.
describe("PRIVATE_TOOLS schema vs. PRIVATE_TOOL_NAMES dispatch gate (WP-7 Ф176)", () => {
  it("every schema-declared private tool name is dispatchable", () => {
    for (const tool of PRIVATE_TOOLS) {
      expect(PRIVATE_TOOL_NAMES.has(tool.name), `"${tool.name}" is listed in PRIVATE_TOOLS but missing from PRIVATE_TOOL_NAMES — tools/call would return "Unknown tool"`).toBe(true);
    }
  });
});

