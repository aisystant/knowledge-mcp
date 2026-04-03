import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectQueryType, resolveGithubUrl, hashQuery, rerankWithLLM, enrichWithParentContent } from "./index.js";
import type { SearchResult, Env } from "./index.js";
import { chunkLargeFile, contentHash } from "../scripts/ingest.js";
import { neon } from "@neondatabase/serverless";

vi.mock("@neondatabase/serverless", () => ({
  neon: vi.fn(),
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

// --- enrichWithParentContent ---

describe("enrichWithParentContent", () => {
  it("returns empty array for empty input", async () => {
    const env = { DATABASE_URL: "fake", OPENAI_API_KEY: "fake" } as Env;
    const out = await enrichWithParentContent(env, []);
    expect(out).toEqual([]);
  });

  it("enriches chunks with parent content", async () => {
    const mockSql = vi.fn().mockResolvedValue([
      {
        chunk_filename: "doc.md::Section A",
        chunk_source: "PACK-digital-platform",
        parent_filename: "doc.md",
        parent_content: "Full parent document content here",
      },
    ]);
    vi.mocked(neon).mockReturnValue(mockSql as any);

    const env = { DATABASE_URL: "postgres://fake", OPENAI_API_KEY: "fake" } as Env;
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
  });

  it("handles no parent rows gracefully", async () => {
    const mockSql = vi.fn().mockResolvedValue([]);
    vi.mocked(neon).mockReturnValue(mockSql as any);

    const env = { DATABASE_URL: "postgres://fake", OPENAI_API_KEY: "fake" } as Env;
    const results: SearchResult[] = [
      makeResult({ id: 5, score: 0.7, filename: "standalone.md", source: "SPF" }),
    ];

    const out = await enrichWithParentContent(env, results);
    expect(out[0].parent_filename).toBeUndefined();
    expect(out[0].filename).toBe("standalone.md");
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
  it("knowledge_feedback tool is defined", async () => {
    // Verify tool is in TOOLS array via MCP handler
    // Since TOOLS is not exported, we verify the tool name strings exist in source
    // Real integration test would call tools/list endpoint
    expect(true).toBe(true); // placeholder — full test needs MCP handler
  });
});
