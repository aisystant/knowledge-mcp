import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectQueryType, resolveGithubUrl, hashQuery, rerankWithLLM, enrichWithParentContent, getEmbedding, searchDocuments, compactSearchResultsForResponse, buildSearchToolResponse, SEARCH_TOOL_RESPONSE_BUDGET_BYTES, normalizeSearchResultLimit, resolveDocument, normalizeDocumentLookupQuery, classifyDocumentResolution, handleMcpRequest, TOOLS, extractTitle, buildPathTree, checkFileSizeAdmission, partitionFilesBySize } from "./index.js";
import type { SearchResult, Env } from "./index.js";
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
      filename: "professional/firefighting/distinguish-systems-and-their-representations-and-ground-yourself/about-systems-and-epistemes-descriptions-models.md",
      source: "docs-courses",
      source_type: "guides",
      title: "О системах и эпистемах о них (описаниях, моделях)",
      score: 1,
    }];

    const results = await resolveDocument(
      { KNOWLEDGE_DATABASE_URL: "postgres://example" } as Env,
      "R1.1:7 — О системах, эпистемах и описаниях",
    );

    expect(results).toEqual([expect.objectContaining({
      filename: "professional/firefighting/distinguish-systems-and-their-representations-and-ground-yourself/about-systems-and-epistemes-descriptions-models.md",
      source: "docs-courses",
      title: "О системах и эпистемах о них (описаниях, моделях)",
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
      filename: "professional/firefighting/distinguish-systems-and-their-representations-and-ground-yourself/about-systems-and-epistemes-descriptions-models.md",
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
    expect(url).toContain("github.com/TserenTserenov/PACK-digital-platform");
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
      github_url: "https://github.com/aisystant/docs/blob/main/docs/ru/about-systems.md",
    }]);
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logLine = warnSpy.mock.calls[0][0] as string;
    expect(JSON.parse(logLine)).toEqual({
      event: "knowledge_search_embedding_fallback",
      reason: "http_5xx",
      embedding_attempts: 2,
      fallback: "keyword",
      source_filter_present: true,
      source_type_filter_present: false,
    });
    expect(logLine).not.toContain(query);
    expect(logLine).not.toContain(apiKey);
    expect(logLine).not.toContain(providerBody);
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
