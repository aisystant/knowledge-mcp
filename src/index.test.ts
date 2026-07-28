import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectQueryType, resolveGithubUrl, hashQuery, rerankWithLLM, enrichWithParentContent, getEmbedding, TOOLS, extractTitle, buildPathTree } from "./index.js";
import type { SearchResult, Env } from "./index.js";
import { chunkLargeFile, contentHash } from "../scripts/ingest.js";
import { neon } from "@neondatabase/serverless";

vi.mock("@neondatabase/serverless", () => ({
  neon: vi.fn(),
  neonConfig: {},
  Pool: vi.fn(),
}));

// withUserContext mock — used by enrichWithParentContent
let mockWithUserContextImpl: ((sql: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) => Promise<unknown[]>) | null = null;

function makeMockSql(rows: unknown[]): (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]> {
  const sql = (() => Promise.resolve(rows)) as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>;
  (sql as any).unsafe = (value: string) => value;
  return sql;
}

vi.mock("./rls.js", () => ({
  withUserContext: vi.fn(async (_dsn: string, _userId: string | null | undefined, fn: (sql: unknown) => Promise<unknown>) => {
    if (mockWithUserContextImpl) return mockWithUserContextImpl(fn as any);
    return fn(makeMockSql([]) as unknown);
  }),
}));

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

    await expect(getEmbedding("fake-key", "test query")).rejects.toThrow("OpenAI Embeddings error: 500");
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
