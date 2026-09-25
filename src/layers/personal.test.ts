// Tests for the private-mode personal-corpus data layer (WP-410 срез-2b).
// Ported logic (search/get_document/list_sources/memory_search/connect_source/delete) is
// exercised against a mocked neon() tag function — no live Neon connection.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";

let queryQueue: unknown[][] = [];
let sqlCalls: unknown[][] = [];

function nextSqlResult(): unknown[] {
  return queryQueue.shift() ?? [];
}

function makeMockSql() {
  const sql = ((...args: unknown[]) => {
    sqlCalls.push(args);
    return Promise.resolve(nextSqlResult());
  }) as unknown as {
    (..._args: unknown[]): Promise<unknown[]>;
    unsafe: (v: string) => string;
    transaction: (queries: Promise<unknown>[]) => Promise<unknown[]>;
  };
  sql.unsafe = (v: string) => v;
  // Queries in the array already fired (and consumed their queryQueue entries) when the
  // array literal was built — awaiting them together is close enough for a unit test.
  sql.transaction = (queries: Promise<unknown>[]) => Promise.all(queries);
  return sql;
}

vi.mock("@neondatabase/serverless", () => ({
  neon: vi.fn(() => makeMockSql()),
}));

import {
  detectPersonalQueryType,
  canonicalContentsPath,
  encodeGitHubContentsPath,
  EXISTENCE_CHECK_NEXT_ACTION,
  getManagedKnowledgeIndexPostEvidence,
  githubBlobUrl,
  githubBranchApiUrl,
  githubContentsApiUrl,
  normalizeRepositoryPath,
  POST_SCAFFOLD_NEXT_ACTION,
  resolveSourcePath,
  allocatePostNumber,
  createPersonalPost,
  ALLOCATOR_LOG_PATH,
  connectSource,
  resolveUserContext,
  deleteFromGitHub,
  writeToGitHub,
  personalListSources,
  personalListDocuments,
  personalListPath,
  personalGetDocument,
  personalGetDocumentLive,
  personalGetDocumentWithSha,
  disconnectSource,
  purgeSource,
  INDEXING_ASYNC_NOTICE,
  type UserContext,
  type PersonalEnv,
} from "./personal.js";
import { normalizePath as normalizeScopePath } from "../scope.js";
import { POST_CONVENTION_PATH } from "../post-scaffold.js";
import { POST_CONVENTION_FIXTURE } from "../post-scaffold.test-fixture.js";

beforeEach(() => {
  queryQueue = [];
  sqlCalls = [];
});

const ENV: PersonalEnv = { DATABASE_URL: "postgres://fake" };

function ctx(overrides: Partial<UserContext> = {}): UserContext {
  return {
    userId: "11111111-1111-1111-1111-111111111111",
    sources: [{ source: "DS-my-strategy", githubOwner: "TserenTserenov", githubRepo: "DS-my-strategy", pathPrefix: "", sourceType: "ds" }],
    sourceNames: ["DS-my-strategy"],
    ...overrides,
  };
}

// getInstallationToken really parses+imports this key (crypto.subtle) before any
// fetch happens, so it must be a structurally valid PKCS#8 RSA key — a throwaway
// one generated fresh per test run, never used to sign anything real.
const { privateKey: TEST_PRIVATE_KEY_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const ENV_WITH_APP: PersonalEnv = { ...ENV, GITHUB_APP_ID: "app-1", GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM };

function responseJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** getInstallationToken() looks up installation_id from knowledge.github_installations
 * (one queryQueue row, pushed here as a side effect since every call site spreads this
 * helper right before its queuedFetch setup) and then issues exactly one HTTP call
 * (POST .../access_tokens) before any Contents API call. */
function installationTokenResponses(): Response[] {
  queryQueue.push([{ installation_id: 42 }]);
  return [
    responseJson({ token: "installation-token" }), // POST /access_tokens
  ];
}

function queuedFetch(items: Response[]) {
  const calls: { url: string; method: string; body?: string }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const item = items.shift();
    if (!item) throw new Error("unexpected fetch call: " + String(input));
    return item;
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const knowledgeIndexTarget = {
  source: "knowledge-index-alias",
  githubOwner: "TserenTserenov",
  githubRepo: "DS-Knowledge-Index-Tseren",
  pathPrefix: "",
  sourceType: "content",
};

function githubDependencies(responses: Array<Partial<Response> & { ok: boolean }>) {
  const request = vi.fn();
  for (const response of responses) request.mockResolvedValueOnce(response);
  return {
    request,
    dependencies: {
      getInstallationToken: vi.fn().mockResolvedValue("ghs_test_token"),
      fetch: request as unknown as typeof globalThis.fetch,
    },
  };
}

describe("encodeGitHubContentsPath", () => {
  it("percent-encodes Cyrillic in each segment while preserving separators", () => {
    expect(encodeGitHubContentsPath("docs/2026/05-август/файл.md")).toBe(
      "docs/2026/05-%D0%B0%D0%B2%D0%B3%D1%83%D1%81%D1%82/%D1%84%D0%B0%D0%B9%D0%BB.md",
    );
  });

  it("encodes spaces and URL control characters without escaping slashes", () => {
    expect(encodeGitHubContentsPath("docs/a b/#tag?/100%.md")).toBe(
      "docs/a%20b/%23tag%3F/100%25.md",
    );
  });
});

describe("normalizeRepositoryPath", () => {
  it("normalizes slash and dot segments while preserving Unicode code points", () => {
    const decomposedPath = "./docs//2026/draft/../cafe\u0301.md";
    expect(normalizeRepositoryPath(decomposedPath)).toBe("docs/2026/cafe\u0301.md");
    expect(githubContentsApiUrl("owner", "repo", decomposedPath)).toBe(
      "https://api.github.com/repos/owner/repo/contents/docs/2026/cafe%CC%81.md",
    );
  });

  it("rejects root escape, absolute paths, NUL, and every literal backslash", () => {
    expect(() => normalizeRepositoryPath("../../docs/2026/post.md")).toThrow("must not escape");
    expect(() => normalizeRepositoryPath("/docs/post.md")).toThrow("must be relative");
    expect(() => normalizeRepositoryPath("a\\b.md")).toThrow("must be relative");
    expect(() => normalizeRepositoryPath("\\a.md")).toThrow("must be relative");
    expect(() => normalizeRepositoryPath("a\0b.md")).toThrow("NUL");
  });

  it("resolves prefixes with and without a trailing slash identically", () => {
    expect(resolveSourcePath("vault", "notes/a.md")).toEqual({
      normalizedPrefix: "vault",
      relativePath: "notes/a.md",
      fullPath: "vault/notes/a.md",
    });
    expect(resolveSourcePath("vault/", "notes/a.md")).toEqual(resolveSourcePath("vault", "notes/a.md"));
  });

  it("encodes a slash-bearing browser ref as one segment", () => {
    expect(githubBlobUrl("owner", "repo", "notes/a.md", "feature/a")).toBe(
      "https://github.com/owner/repo/blob/feature%2Fa/notes/a.md",
    );
    expect(githubBranchApiUrl("owner", "repo", "feature/a")).toBe(
      "https://api.github.com/repos/owner/repo/branches/feature%2Fa",
    );
  });
});

describe("Knowledge Index publication creation guard", () => {
  const postPath = "docs/2026/05-август/40-08-2026-08-27-topic/40-08-1-club-2026-08-27.md";
  const postContent = "---\ntype: post\ntitle: Topic\n---\n# Topic";
  const weekReviewContent = "---\ntype: week_review\n---\n# Week review";
  const targetContext = ctx({ sources: [knowledgeIndexTarget], sourceNames: [knowledgeIndexTarget.source] });

  it("detects noncanonical type:post frontmatter", () => {
    expect(getManagedKnowledgeIndexPostEvidence(
      knowledgeIndexTarget,
      "docs/2026/drafts/noncanonical.md",
      postContent,
    )).toBe("frontmatter_type_post");
  });

  it.each([
    "40-08-1-club-2026-08-27.md",
    "40-08-8-dzen-2026-08-27.md",
    "072-7-habr-2026-03-19.md",
  ])("detects channel filename %s without frontmatter", filename => {
    expect(getManagedKnowledgeIndexPostEvidence(
      knowledgeIndexTarget,
      `docs/2026/month/topic/${filename}`,
      "# body",
    )).toBe("channel_filename");
  });

  it("allows ordinary Markdown, non-post week review, docs2, and another resolved repository", () => {
    const otherTarget = { githubOwner: "TserenTserenov", githubRepo: "DS-my-strategy" };
    expect(getManagedKnowledgeIndexPostEvidence(knowledgeIndexTarget, "docs/2026/notes.md", "# note")).toBeNull();
    expect(getManagedKnowledgeIndexPostEvidence(
      knowledgeIndexTarget,
      "docs/2026/2026-08-24-week-review-w34.md",
      weekReviewContent,
    )).toBeNull();
    expect(getManagedKnowledgeIndexPostEvidence(knowledgeIndexTarget, "docs2/2026/post.md", postContent)).toBeNull();
    expect(getManagedKnowledgeIndexPostEvidence(otherTarget, postPath, postContent)).toBeNull();
  });

  it("does not treat an incidental week-review substring as a service-file bypass", () => {
    expect(getManagedKnowledgeIndexPostEvidence(
      knowledgeIndexTarget,
      "docs/2026/drafts/topic-week-review-bypass.md",
      postContent,
    )).toBe("frontmatter_type_post");
  });

  it("does not let a service-style filename override explicit type: post", async () => {
    const servicePath = "docs/2026/2026-08-24-week-review-w34.md";
    expect(getManagedKnowledgeIndexPostEvidence(
      knowledgeIndexTarget,
      servicePath,
      postContent,
    )).toBe("frontmatter_type_post");

    const { request, dependencies } = githubDependencies([{ ok: false, status: 404 }]);
    const result = await writeToGitHub(
      ENV, targetContext, knowledgeIndexTarget.source, servicePath, postContent, "create", dependencies,
    );

    expect(result).toMatchObject({ success: false, reason: "post_scaffold_required" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("returns a structured scaffold instruction on 404 without issuing PUT", async () => {
    const { request, dependencies } = githubDependencies([{ ok: false, status: 404 }]);
    const expectedUrl = "https://api.github.com/repos/TserenTserenov/DS-Knowledge-Index-Tseren/contents/" +
      "docs/2026/05-%D0%B0%D0%B2%D0%B3%D1%83%D1%81%D1%82/40-08-2026-08-27-topic/40-08-1-club-2026-08-27.md";

    const result = await writeToGitHub(
      ENV,
      targetContext,
      knowledgeIndexTarget.source,
      postPath,
      postContent,
      "create post",
      dependencies,
    );

    expect(result).toMatchObject({
      success: false,
      reason: "post_scaffold_required",
      evidence: "frontmatter_type_post",
      next_action: POST_SCAFFOLD_NEXT_ACTION,
    });
    expect(result.next_action).toContain("scripts/new-post.py");
    expect(result.next_action).toContain("ASCII/manual fallback");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expectedUrl,
      expect.not.objectContaining({ method: "PUT" }),
    );
  });

  it.each([
    ["401", { ok: false, status: 401 }],
    ["403", { ok: false, status: 403 }],
    ["5xx", { ok: false, status: 503 }],
    ["invalid JSON", { ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); } }],
    ["invalid blob SHA", { ok: true, status: 200, json: async () => ({ sha: "not-a-sha" }) }],
  ])("fails closed with existence_check_unavailable on %s", async (_case, response) => {
    const { request, dependencies } = githubDependencies([response]);
    const result = await writeToGitHub(
      ENV, targetContext, knowledgeIndexTarget.source, postPath, postContent, "write", dependencies,
    );

    expect(result).toMatchObject({
      success: false,
      reason: "existence_check_unavailable",
      next_action: EXISTENCE_CHECK_NEXT_ACTION,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a network error", async () => {
    const request = vi.fn().mockRejectedValue(new Error("network down"));
    const result = await writeToGitHub(
      ENV, targetContext, knowledgeIndexTarget.source, postPath, postContent, "write",
      { getInstallationToken: vi.fn().mockResolvedValue("ghs_test_token"), fetch: request as unknown as typeof globalThis.fetch },
    );

    expect(result).toMatchObject({ success: false, reason: "existence_check_unavailable" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  // Policy B (WP-7 F-WriteToGitHubParity, 04.09) — supersedes the 03.09 policy A
  // pin ("fails closed for an ordinary write when target existence is
  // unavailable"): an inconclusive existence check now blocks only a
  // managed-post candidate; an ordinary file proceeds as if missing, and
  // GitHub's own sha requirement on PUT still catches a real conflict.
  it("proceeds to PUT for an ordinary write when target existence is unavailable, and creates the file", async () => {
    const { request, dependencies } = githubDependencies([
      { ok: false, status: 503 }, // existence check: transient failure, not a 404
      { ok: true, status: 200, json: async () => ({ content: { sha: "b".repeat(40), html_url: "https://github.test/note" } }) }, // PUT
    ]);

    const result = await writeToGitHub(
      ENV,
      ctx(),
      "DS-my-strategy",
      "notes/new.md",
      "# Ordinary note",
      "create note",
      dependencies,
    );

    expect(result.success).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    const put = request.mock.calls[1][1] as RequestInit;
    expect(put).toEqual(expect.objectContaining({ method: "PUT" }));
    expect(JSON.parse(put.body as string)).not.toHaveProperty("sha");
  });

  it("surfaces version_mismatch, not existence_check_unavailable, when the inconclusive check masked an existing ordinary file", async () => {
    const { request, dependencies } = githubDependencies([
      { ok: false, status: 503 }, // existence check: transient failure
      { ok: false, status: 422, text: async () => "sha wasn't supplied" }, // PUT rejected: file actually exists
    ]);

    const result = await writeToGitHub(
      ENV,
      ctx(),
      "DS-my-strategy",
      "notes/new.md",
      "attempted write",
      "update",
      dependencies,
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe("version_mismatch");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("allows personal_write to update a confirmed existing publication", async () => {
    const existingSha = "a".repeat(40);
    const { request, dependencies } = githubDependencies([
      { ok: true, status: 200, json: async () => ({ sha: existingSha }) },
      { ok: true, status: 200, json: async () => ({ content: { sha: "b".repeat(40), html_url: "https://github.test/post" } }) },
    ]);
    const targetContext = ctx({ sources: [knowledgeIndexTarget], sourceNames: [knowledgeIndexTarget.source] });

    const result = await writeToGitHub(
      ENV,
      targetContext,
      knowledgeIndexTarget.source,
      postPath,
      postContent,
      "update post",
      dependencies,
    );

    expect(result.success).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    const resolvedFullPath = resolveSourcePath(knowledgeIndexTarget.pathPrefix, postPath).fullPath;
    const expectedUrl = githubContentsApiUrl(
      knowledgeIndexTarget.githubOwner,
      knowledgeIndexTarget.githubRepo,
      resolvedFullPath,
    );
    expect(request.mock.calls[0][0]).toBe(expectedUrl);
    expect(request.mock.calls[1][0]).toBe(expectedUrl);
    expect(request.mock.calls[1][1]).toEqual(expect.objectContaining({ method: "PUT" }));
    expect(JSON.parse((request.mock.calls[1][1] as RequestInit).body as string)).toEqual(expect.objectContaining({ sha: existingSha }));
  });

  it.each([
    ["ordinary Markdown", "docs/2026/ordinary.md", "# Ordinary"],
    ["week review service file", "docs/2026/2026-08-24-week-review-w34.md", weekReviewContent],
  ])("allows %s creation on a confirmed 404", async (_case, ordinaryPath, content) => {
    const { request, dependencies } = githubDependencies([
      { ok: false, status: 404 },
      { ok: true, status: 201, json: async () => ({ content: { sha: "d".repeat(40), html_url: "https://github.test/file" } }) },
    ]);

    const result = await writeToGitHub(
      ENV, targetContext, knowledgeIndexTarget.source, ordinaryPath, content, "create", dependencies,
    );

    expect(result.success).toBe(true);
    // WP-7 Ф97.1: every successful write carries the async-indexing notice —
    // the write is confirmed, search indexing is not.
    expect(result.indexing).toEqual({ status: "async", note: expect.stringContaining("Индексация для поиска идёт фоново") });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][1]).toEqual(expect.objectContaining({ method: "PUT" }));
  });

  it.each(["docs", "docs/"])("resolves pathPrefix %s before policy and URL checks", async pathPrefix => {
    const prefixedTarget = { ...knowledgeIndexTarget, pathPrefix };
    const prefixedContext = ctx({ sources: [prefixedTarget], sourceNames: [prefixedTarget.source] });
    const { request, dependencies } = githubDependencies([{ ok: false, status: 404 }]);

    const result = await writeToGitHub(
      ENV, prefixedContext, prefixedTarget.source,
      "2026/topic/40-08-8-dzen-2026-08-27.md", "# body", "create", dependencies,
    );

    expect(result.reason).toBe("post_scaffold_required");
    expect(request.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/TserenTserenov/DS-Knowledge-Index-Tseren/contents/docs/2026/topic/40-08-8-dzen-2026-08-27.md",
    );
  });

  it.each(["a\\b.md", "\\a.md"])("rejects invalid path %s before fetch", async invalidPath => {
    const request = vi.fn();
    const getToken = vi.fn();
    const result = await writeToGitHub(
      ENV, targetContext, knowledgeIndexTarget.source, invalidPath, "# body", "write",
      { getInstallationToken: getToken, fetch: request as unknown as typeof globalThis.fetch },
    );

    expect(result.success).toBe(false);
    expect(getToken).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});

describe("detectPersonalQueryType", () => {
  it("routes entity codes to keyword", () => {
    expect(detectPersonalQueryType("DP.AGENT.001")).toBe("keyword");
  });

  it("routes natural language to vector", () => {
    expect(detectPersonalQueryType("как подключить репозиторий")).toBe("vector");
  });
});

describe("personalListSources", () => {
  it("maps rows scoped to the caller's sourceNames", async () => {
    queryQueue.push([{ source: "DS-my-strategy", source_type: "ds", doc_count: 3 }]);
    const result = await personalListSources(ENV, ctx());
    expect(result).toEqual([{ source: "DS-my-strategy", source_type: "ds", doc_count: 3 }]);
  });

  it("returns an empty list when the user has no documents", async () => {
    queryQueue.push([]);
    const result = await personalListSources(ENV, ctx());
    expect(result).toEqual([]);
  });
});

describe("personalListDocuments", () => {
  it("maps rows scoped to the caller's sourceNames, with a resolved github_url and byte size", async () => {
    // size_bytes as SUM(octet_length(content))::bigint would come back from Postgres — a
    // single aggregated row per file, chunk count already collapsed server-side (WP-7 Ф122).
    // size_bytes: string "42", not number 42 — the Neon/postgres.js driver returns BIGINT
    // columns as strings by default; Number(r.size_bytes ?? 0) in the implementation must
    // coerce that shape, not just the JS-number shape a careless mock would use.
    queryQueue.push([{ filename: "notes/idea.md", source: "DS-my-strategy", source_type: "ds", size_bytes: "42" }]);
    const result = await personalListDocuments(ENV, ctx());
    expect(result).toEqual([{
      filename: "notes/idea.md",
      source: "DS-my-strategy",
      source_type: "ds",
      github_url: expect.stringContaining("github.com/TserenTserenov/DS-my-strategy"),
      size_bytes: 42,
    }]);
  });

  it("returns an empty list when the user has no documents", async () => {
    queryQueue.push([]);
    const result = await personalListDocuments(ENV, ctx());
    expect(result).toEqual([]);
  });
});

describe("personalListPath", () => {
  it("builds a path tree from the caller's own documents, with title and byte size from full_content", async () => {
    // full_content as string_agg(content, '' ORDER BY chunk_ordinal) — the query GROUPs by
    // filename so a multi-chunk v2 document (several rows sharing one filename, see
    // personalGetDocument's v2Rows) comes back as ONE row here with content already
    // reassembled in order, not one row per chunk (WP-7 Ф122 — the pre-fix query returned
    // one row per chunk, which made buildPathTree emit a duplicate "file" entry per chunk).
    queryQueue.push([
      { filename: "docs/intro.md", source: "DS-my-strategy", full_content: "# Intro\n\nBody text." },
      { filename: "docs/guide/setup.md", source: "DS-my-strategy", full_content: "# Setup" },
    ]);
    const entries = await personalListPath(ENV, ctx(), undefined, "docs/", 1);
    expect(entries).toEqual([
      { type: "dir", source: "DS-my-strategy", path: "docs/guide", title: null, size_bytes: undefined },
      { type: "file", source: "DS-my-strategy", path: "docs/intro.md", title: "Intro", size_bytes: 19 },
    ]);
  });

  it("returns an empty tree when the user has no documents", async () => {
    queryQueue.push([]);
    const entries = await personalListPath(ENV, ctx());
    expect(entries).toEqual([]);
  });
});

describe("personalGetDocument", () => {
  it("returns null when no matching document exists", async () => {
    queryQueue.push([]); // ambiguity pre-check (source omitted → runs first)
    queryQueue.push([]); // v2 query
    queryQueue.push([]); // legacy fallback
    const doc = await personalGetDocument(ENV, ctx(), "missing.md");
    expect(doc).toBeNull();
  });

  it("returns the document content and a resolved github_url for a known source", async () => {
    // source given explicitly — skips the ambiguity pre-check (WP-7 Ф94)
    queryQueue.push([{ filename: "notes/idea.md", content: "hello", source: "DS-my-strategy", source_type: "ds", chunk_ordinal: 1 }]); // v2 query
    const doc = await personalGetDocument(ENV, ctx(), "notes/idea.md", "DS-my-strategy");
    expect(doc?.content).toBe("hello");
    expect(doc?.github_url).toContain("github.com/TserenTserenov/DS-my-strategy");
  });

  it.each(["vault", "vault/"])("uses literal chunk matching and an encoded HEAD URL with prefix %s", async pathPrefix => {
    const rawFilename = "notes/./cafe\u0301_%#? file.md";
    const normalizedFilename = "notes/cafe\u0301_%#? file.md";
    // Merged Ф94 query order with source omitted: ambiguity pre-check → v2 → legacy.
    queryQueue.push([{ source: "DS-my-strategy" }]);
    queryQueue.push([]); // v2 — not backfilled in this fixture
    queryQueue.push([{ filename: normalizedFilename, content: "hello", source: "DS-my-strategy", source_type: "ds" }]);
    const sourceContext = ctx({
      sources: [{ ...ctx().sources[0], pathPrefix }],
    });

    const doc = await personalGetDocument(ENV, sourceContext, rawFilename);

    expect(doc?.content).toBe("hello");
    expect(doc?.github_url).toBe(
      "https://github.com/TserenTserenov/DS-my-strategy/blob/HEAD/vault/notes/cafe%CC%81_%25%23%3F%20file.md",
    );
    const [template, ...values] = sqlCalls.at(-1) as [TemplateStringsArray, ...unknown[]];
    expect(template.join(" ")).not.toContain(" LIKE ");
    expect(values).toContain(normalizedFilename);
    expect(values).toContain(`${normalizedFilename}::`);
  });

  it("joins multiple v2 chunks in the order returned, not just the first (WP-7 Ф94 regression)", async () => {
    queryQueue.push([
      { filename: "docs/big.md", content: "part one. ", source: "DS-my-strategy", source_type: "ds", chunk_ordinal: 1 },
      { filename: "docs/big.md", content: "part two. ", source: "DS-my-strategy", source_type: "ds", chunk_ordinal: 2 },
      { filename: "docs/big.md", content: "part three.", source: "DS-my-strategy", source_type: "ds", chunk_ordinal: 3 },
    ]); // v2 query — source given, no ambiguity pre-check
    const doc = await personalGetDocument(ENV, ctx(), "docs/big.md", "DS-my-strategy");
    expect(doc?.content).toBe("part one. part two. part three.");
  });

  it("falls back to the legacy read when no v2 rows exist yet (WP-7 Ф94 regression)", async () => {
    queryQueue.push([]); // v2 query — empty, not yet backfilled
    queryQueue.push([{ filename: "docs/old.md::intro", content: "legacy content", source: "DS-my-strategy", source_type: "ds" }]); // legacy fallback
    const doc = await personalGetDocument(ENV, ctx(), "docs/old.md", "DS-my-strategy");
    expect(doc?.content).toBe("legacy content");
  });

  it("throws when the path exists in 2+ sources and source is omitted (WP-7 Ф94 regression)", async () => {
    queryQueue.push([{ source: "DS-my-strategy" }, { source: "DS-other" }]); // ambiguity pre-check
    await expect(
      personalGetDocument(ENV, ctx({ sourceNames: ["DS-my-strategy", "DS-other"] }), "docs/shared.md"),
    ).rejects.toThrow(/multiple sources/);
  });
});

describe("deleteFromGitHub", () => {
  it("rejects an unknown source without touching the network", async () => {
    const result = await deleteFromGitHub(ENV, ctx(), "not-a-real-source", "notes/idea.md", "delete");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown source");
  });

  it.each(["vault", "vault/"])("uses encoded URL and literal DB cleanup with prefix %s", async pathPrefix => {
    const sha = "c".repeat(40);
    const { request, dependencies } = githubDependencies([
      { ok: true, status: 200, json: async () => ({ sha }) },
      { ok: true, status: 200 },
    ]);
    queryQueue.push([]); // indexed document cleanup
    const path = "notes/./cafe\u0301_%#? file.md";
    const sourceContext = ctx({ sources: [{ ...ctx().sources[0], pathPrefix }] });

    const result = await deleteFromGitHub(ENV, sourceContext, "DS-my-strategy", path, "delete", dependencies);

    expect(result.success).toBe(true);
    const expectedUrl = "https://api.github.com/repos/TserenTserenov/DS-my-strategy/contents/" +
      "vault/notes/cafe%CC%81_%25%23%3F%20file.md";
    expect(request.mock.calls[0][0]).toBe(expectedUrl);
    expect(request.mock.calls[1][0]).toBe(expectedUrl);
    expect(request.mock.calls[1][1]).toEqual(expect.objectContaining({ method: "DELETE" }));
    const [template, ...values] = sqlCalls.at(-1) as [TemplateStringsArray, ...unknown[]];
    expect(template.join(" ")).not.toContain(" LIKE ");
    const normalizedPath = normalizeScopePath(path);
    expect(normalizedPath).toBe(resolveSourcePath(pathPrefix, path).relativePath);
    expect(values).toContain(normalizedPath);
    expect(values).toContain(`${normalizedPath}::`);
  });
});

describe("allocatePostNumber (WP-560 Ф12)", () => {
  const DRAFT_ID = "01996b1a-0000-7000-8000-000000000001";
  const OTHER_DRAFT_ID = "01996b1a-0000-7000-8000-000000000002";
  const allocatorContext = ctx({ sources: [knowledgeIndexTarget], sourceNames: [knowledgeIndexTarget.source] });
  const POST_PATH = "docs/2026/04-сентябрь/13-09-2026-09-25-post/13-09-1-club-2026-09-25.md";
  const entry = (number: number, draftId = OTHER_DRAFT_ID) => ({
    draft_id: draftId, artifact_type: "post", post_number: number, timestamp: "2026-09-24T18:50:00.000Z",
  });
  const log = (...entries: unknown[]) => entries.map(value => JSON.stringify(value)).join("\n") + "\n";
  const post = (number: number, draftId?: string) =>
    `---\ntype: post\npost_number: ${number}\n${draftId ? `draft_id: ${draftId}\n` : ""}---\nBody`;

  // A small Git object store models observable branch updates. Objects are immutable;
  // branch updates succeed only when the candidate's parent is still the current head.
  class FakeGitHub {
    private readonly blobs = new Map<string, string>();
    private readonly trees = new Map<string, Record<string, string>>();
    private readonly commits = new Map<string, { tree: string; parent: string | null }>();
    head: string;
    readonly calls: Array<{ method: string; path: string; body: any }> = [];
    beforePatch?: () => void;
    truncated = false;
    mismatchedTree = false;
    mismatchedCommit = false;
    brokenBlob = false;
    graphErrors = false;
    patchBlob?: (blob: Record<string, unknown>) => Record<string, unknown> | null;
    afterBlobBatch?: () => void;
    reportedSize?: number;
    patchStatus?: number;
    readonly branch = "main";
    readonly authorizePaths = vi.fn<(paths: string[]) => Promise<void>>().mockResolvedValue(undefined);

    constructor(files: Record<string, string> = {}) {
      this.head = this.commit(files, null);
    }

    private oid(value: string): string { return createHash("sha1").update(value).digest("hex"); }

    private saveTree(files: Record<string, string>): string {
      const refs = Object.fromEntries(Object.entries(files).map(([path, content]) => {
        const sha = this.oid(`blob:${content}`);
        this.blobs.set(sha, content);
        return [path, sha];
      }));
      const sha = this.oid(`tree:${JSON.stringify(refs)}`);
      this.trees.set(sha, refs);
      return sha;
    }

    private commit(files: Record<string, string>, parent: string | null): string {
      const tree = this.saveTree(files);
      const sha = this.oid(`commit:${tree}:${parent}`);
      this.commits.set(sha, { tree, parent });
      return sha;
    }

    files(head = this.head): Record<string, string> {
      const tree = this.commits.get(head)!.tree;
      return Object.fromEntries(Object.entries(this.trees.get(tree)!).map(([path, sha]) => [path, this.blobs.get(sha)!]));
    }

    externalWrite(path: string, content: string): void {
      this.head = this.commit({ ...this.files(), [path]: content }, this.head);
    }

    externalDelete(path: string): void {
      const files = this.files();
      delete files[path];
      this.head = this.commit(files, this.head);
    }

    scaffold(input: unknown, draftId = DRAFT_ID) {
      return createPersonalPost(ENV, allocatorContext, {
        source: knowledgeIndexTarget.source, draftId, artifactType: "post", scaffold: input,
      }, { getInstallationToken: vi.fn().mockResolvedValue("test-token"), fetch: this.request,
        authorizePaths: this.authorizePaths });
    }

    entries(): Array<ReturnType<typeof entry>> {
      return (this.files()[ALLOCATOR_LOG_PATH] ?? "").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    }

    request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      this.calls.push({ method, path, body });
      if (path.startsWith("/contents/")) {
        const filename = decodeURIComponent(path.slice("/contents/".length));
        const tree = this.trees.get(this.commits.get(this.head)!.tree)!;
        if (!tree[filename]) return responseJson({ message: "Not Found" }, 404);
        if (method === "GET") return responseJson({ sha: tree[filename], encoding: "base64",
          content: Buffer.from(this.files()[filename]).toString("base64") });
        if (method === "PUT") {
          if (body.sha !== tree[filename]) return responseJson({ message: "sha mismatch" }, 409);
          this.externalWrite(filename, Buffer.from(body.content, "base64").toString("utf8"));
          return responseJson({ content: { sha: this.trees.get(this.commits.get(this.head)!.tree)![filename], html_url: "https://example.test/file" } });
        }
      }
      if (method === "GET" && path === "") return responseJson({ default_branch: this.branch });
      if (method === "GET" && path === `/git/ref/heads/${this.branch}`) {
        return responseJson({ object: { sha: this.head, type: "commit" } });
      }
      if (method === "GET" && path.startsWith("/git/commits/")) {
        const sha = path.split("/").at(-1)!;
        return responseJson({ sha: this.mismatchedCommit ? "0".repeat(40) : sha,
          tree: { sha: this.commits.get(sha)!.tree } });
      }
      if (method === "GET" && path.startsWith("/git/trees/")) {
        const tree = this.trees.get(path.split("/").at(-1)!)!;
        return responseJson({ sha: this.mismatchedTree ? "0".repeat(40) : path.split("/").at(-1),
          truncated: this.truncated,
          tree: Object.entries(tree).map(([path, sha]) => ({ path, sha, type: "blob", mode: "100644",
            size: this.reportedSize ?? Buffer.byteLength(this.blobs.get(sha)!) })) });
      }
      if (method === "POST" && path === "/graphql") {
        if (this.brokenBlob) return responseJson({ message: "unavailable" }, 503);
        expect(body.variables).toEqual({ owner: knowledgeIndexTarget.githubOwner, repo: knowledgeIndexTarget.githubRepo });
        const repository: Record<string, unknown> = {};
        for (const match of body.query.matchAll(/(b\d+): object\(oid: "([a-f0-9]+)"\)/g)) {
          const [, alias, oid] = match;
          const text = this.blobs.get(oid)!;
          const blob = { oid, text, byteSize: Buffer.byteLength(text), isBinary: false, isTruncated: false };
          repository[alias] = this.patchBlob ? this.patchBlob(blob) : blob;
        }
        this.afterBlobBatch?.();
        return responseJson({ data: { repository }, ...(this.graphErrors ? { errors: [{ message: "partial error" }] } : {}) });
      }
      if (method === "POST" && path === "/git/trees") {
        const base = this.trees.get(body.base_tree)!;
        const files = Object.fromEntries(Object.entries(base).map(([path, sha]) => [path, this.blobs.get(sha)!]));
        for (const file of body.tree) files[file.path] = file.content;
        return responseJson({ sha: this.saveTree(files) }, 201);
      }
      if (method === "POST" && path === "/git/commits") {
        const sha = this.oid(`commit:${body.tree}:${body.parents[0]}`);
        this.commits.set(sha, { tree: body.tree, parent: body.parents[0] });
        return responseJson({ sha }, 201);
      }
      if (method === "PATCH" && path === `/git/refs/heads/${this.branch}`) {
        this.beforePatch?.();
        if (this.patchStatus) return responseJson({ message: "protected branch" }, this.patchStatus);
        if (body.force !== false) throw new Error("Force updates are forbidden");
        if (this.commits.get(body.sha)?.parent !== this.head) return responseJson({ message: "Update is not a fast forward" }, 422);
        this.head = body.sha;
        return responseJson({ object: { sha: this.head } });
      }
      throw new Error(`Unexpected GitHub request ${method} ${path}`);
    });

    allocate(draftId = DRAFT_ID) {
      return allocatePostNumber(ENV, allocatorContext, knowledgeIndexTarget.source, draftId, "post", {
        getInstallationToken: vi.fn().mockResolvedValue("test-token"), fetch: this.request,
      });
    }
  }

  it("rejects invalid UUID/type and unknown source without network access", async () => {
    const fetch = vi.fn();
    for (const [source, draftId, type, reason] of [
      [knowledgeIndexTarget.source, "invalid", "post", "invalid_draft_id"],
      [knowledgeIndexTarget.source, DRAFT_ID, "pack", "invalid_artifact_type"],
      ["unknown", DRAFT_ID, "post", "unknown_source"],
    ]) {
      expect(await allocatePostNumber(ENV, allocatorContext, source, draftId, type, { fetch }))
        .toMatchObject({ success: false, reason });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reserves #1 in an empty repository through a non-forced Git ref update", async () => {
    const git = new FakeGitHub({ "README.md": "keep me" });
    expect(await git.allocate()).toMatchObject({ success: true, post_number: 1, reused: false });
    expect(git.files()["README.md"]).toBe("keep me");
    expect(git.entries()).toEqual([expect.objectContaining({ draft_id: DRAFT_ID, post_number: 1 })]);
    expect(git.calls.filter(call => call.method === "PATCH")).toEqual([
      expect.objectContaining({ body: { sha: git.head, force: false } }),
    ]);
  });

  it("reserves #234 with live-shaped posts #233 and allocator seed #232", async () => {
    const original = log(entry(1, "2ad290d7-d9de-4f9a-be0f-a4c9232ca9ee"), entry(232));
    const git = new FakeGitHub({ [ALLOCATOR_LOG_PATH]: original, [POST_PATH]: post(233) });
    expect(await git.allocate()).toMatchObject({ success: true, post_number: 234 });
    expect(git.files()[ALLOCATOR_LOG_PATH].startsWith(original)).toBe(true);
    expect(git.entries().map(value => value.post_number)).toEqual([1, 232, 234]);
    expect(git.files()[POST_PATH]).toBe(post(233));
  });

  it("bootstraps from legacy filename numbers and preserves unnumbered monthly posts", async () => {
    const git = new FakeGitHub({ "docs/2026/old/233-1-club-2026-09-01.md": "Legacy body",
      [POST_PATH]: "---\ntype: post\n---\nUnnumbered draft" });
    expect(await git.allocate()).toMatchObject({ success: true, post_number: 234 });
  });

  it("reads quoted historical numbers only inside frontmatter", async () => {
    const git = new FakeGitHub({ [POST_PATH]: '---\npost_number: "233" # legacy\n---\npost_number: 999' });
    expect(await git.allocate()).toMatchObject({ success: true, post_number: 234 });
  });

  it.each(["null", "", "~"])("treats actual YAML null (%s) as an unnumbered monthly post", async value => {
    const git = new FakeGitHub({ [POST_PATH]: `---\npost_number: ${value}\n---\nBody` });
    expect(await git.allocate()).toMatchObject({ success: true, post_number: 1 });
  });

  it("uses the legacy filename if its explicit global number is YAML null", async () => {
    const git = new FakeGitHub({ "docs/old/233-1-club-2026-09-01.md": "---\npost_number: null\n---\nBody" });
    expect(await git.allocate()).toMatchObject({ success: true, post_number: 234 });
  });

  it.each(["post_number: 'null'", `post_number: null\ndraft_id: ${DRAFT_ID}`, `draft_id: ${DRAFT_ID}`])(
    "rejects a string-null number or draft ownership without a global number: %s", async fields => {
      const git = new FakeGitHub({ [POST_PATH]: `---\n${fields}\n---\nBody` });
      expect(await git.allocate()).toMatchObject({ success: false, reason: "invalid_allocator_state" });
      expect(git.calls.some(call => call.path !== "/graphql" && call.method !== "GET")).toBe(false);
    },
  );

  it("respects a quoted YAML key instead of silently ignoring the number", async () => {
    const git = new FakeGitHub({ [POST_PATH]: '---\n"post_number": 233\n---\nBody' });
    expect(await git.allocate()).toMatchObject({ success: true, post_number: 234 });
  });

  it.each([
    "not json", "null", "[]", log({ ...entry(232), post_number: "232" }),
    log({ ...entry(232), post_number: -1 }), log({ ...entry(232), post_number: 1.5 }),
    log({ ...entry(232), post_number: Number.MAX_SAFE_INTEGER + 1 }),
    log({ ...entry(232), artifact_type: "pack" }), log({ ...entry(232), draft_id: "invalid" }),
    log({ ...entry(232), timestamp: "yesterday" }), log(entry(232), entry(233)),
    log(entry(232), entry(232, DRAFT_ID)), log(entry(232), entry(233, OTHER_DRAFT_ID.toUpperCase())),
  ])("rejects malformed/ambiguous log without publishing a Git ref: %s", async raw => {
    const git = new FakeGitHub({ [ALLOCATOR_LOG_PATH]: raw });
    const originalHead = git.head;
    expect(await git.allocate()).toMatchObject({ success: false, reason: "invalid_allocator_state" });
    expect(git.head).toBe(originalHead);
    expect(git.calls.some(call => call.path !== "/graphql" && call.method !== "GET")).toBe(false);
  });

  it("rejects a truncated tree before reading or modifying content", async () => {
    const git = new FakeGitHub({ [POST_PATH]: post(233) });
    git.truncated = true;
    expect(await git.allocate()).toMatchObject({ success: false, reason: "invalid_allocator_state" });
    expect(git.calls.some(call => call.path !== "/graphql" && call.method !== "GET")).toBe(false);
  });

  it.each(["mismatchedTree", "mismatchedCommit"] as const)("rejects immutable object identity mismatch (%s)", async flag => {
    const git = new FakeGitHub({ [POST_PATH]: post(233) });
    git[flag] = true;
    expect(await git.allocate()).toMatchObject({ success: false, reason: "invalid_allocator_state" });
    expect(git.calls.some(call => call.method !== "GET")).toBe(false);
  });

  it("rejects an unreadable historical blob before creating Git objects", async () => {
    const git = new FakeGitHub({ [POST_PATH]: post(233) });
    git.brokenBlob = true;
    expect(await git.allocate()).toMatchObject({ success: false, reason: "github_error" });
    expect(git.calls.some(call => call.path !== "/graphql" && call.method !== "GET")).toBe(false);
  });

  it.each(["post_number: oops", "post_number: 0", "post_number: 232\npost_number: 233", "post_number: 233\ndraft_id: invalid",
    "post_number: 1e3", "post_number: |\n  233", "post_number: &num 233\n<<: {post_number: 234}",
    "number: &num 233\npost_number: *num", '"post_number": 233\npost_number: 234',
    "post_number: !custom 233"])(
    "rejects malformed historical ownership: %s", async fields => {
      const git = new FakeGitHub({ [POST_PATH]: `---\n${fields}\n---\nBody` });
      expect(await git.allocate()).toMatchObject({ success: false, reason: "invalid_allocator_state" });
      expect(git.calls.some(call => call.path !== "/graphql" && call.method !== "GET")).toBe(false);
    },
  );

  it("reuses a reservation case-insensitively without a new Git commit", async () => {
    const git = new FakeGitHub({ [ALLOCATOR_LOG_PATH]: log(entry(233, DRAFT_ID)) });
    const head = git.head;
    expect(await git.allocate(DRAFT_ID.toUpperCase())).toMatchObject({ success: true, post_number: 233, draft_id: DRAFT_ID, reused: true });
    expect(git.head).toBe(head);
    expect(git.calls.some(call => call.path !== "/graphql" && call.method !== "GET")).toBe(false);
  });

  it("reuses an existing post only with matching draft ownership", async () => {
    const git = new FakeGitHub({ [ALLOCATOR_LOG_PATH]: log(entry(233, DRAFT_ID)), [POST_PATH]: post(233, DRAFT_ID) });
    expect(await git.allocate()).toMatchObject({ success: true, post_number: 233, reused: true });
    expect(git.calls.some(call => call.path !== "/graphql" && call.method !== "GET")).toBe(false);
  });

  it.each([undefined, OTHER_DRAFT_ID])("refuses a historic number owned by another/unknown draft (%s)", async draftId => {
    const git = new FakeGitHub({ [ALLOCATOR_LOG_PATH]: log(entry(233, DRAFT_ID)), [POST_PATH]: post(233, draftId) });
    expect(await git.allocate()).toMatchObject({ success: false, reason: "post_number_ownership_conflict" });
    expect(git.calls.some(call => call.path !== "/graphql" && call.method !== "GET")).toBe(false);
  });

  it("re-reads history after a competing post-only commit leaves the log unchanged", async () => {
    const git = new FakeGitHub({ [ALLOCATOR_LOG_PATH]: log(entry(232)) });
    git.beforePatch = () => { git.beforePatch = undefined; git.externalWrite(POST_PATH, post(233)); };
    expect(await git.allocate()).toMatchObject({ success: true, post_number: 234 });
    expect(git.entries().map(value => value.post_number)).toEqual([232, 234]);
    expect(git.files()[POST_PATH]).toBe(post(233));
    expect(git.calls.filter(call => call.method === "PATCH")).toHaveLength(2);
  });

  it("reuses a same-draft reservation that wins the ref race", async () => {
    const git = new FakeGitHub({ [ALLOCATOR_LOG_PATH]: log(entry(232)) });
    git.beforePatch = () => { git.beforePatch = undefined; git.externalWrite(ALLOCATOR_LOG_PATH, log(entry(232), entry(233, DRAFT_ID))); };
    expect(await git.allocate()).toMatchObject({ success: true, post_number: 233, reused: true });
    expect(git.entries()).toHaveLength(2);
    expect(git.calls.filter(call => call.method === "PATCH")).toHaveLength(1);
  });

  it("gives concurrent distinct drafts distinct numbers and preserves both log entries", async () => {
    const git = new FakeGitHub();
    const results = await Promise.all([git.allocate(DRAFT_ID), git.allocate(OTHER_DRAFT_ID)]);
    expect(results.every(result => result.success)).toBe(true);
    expect(results.map(result => result.post_number).sort()).toEqual([1, 2]);
    expect(new Set(git.entries().map(value => value.draft_id))).toEqual(new Set([DRAFT_ID, OTHER_DRAFT_ID]));
  });

  it("stops after five ref conflicts without publishing any reservation", async () => {
    const git = new FakeGitHub();
    let writes = 0;
    git.beforePatch = () => git.externalWrite("README.md", `concurrent ${++writes}`);
    expect(await git.allocate()).toMatchObject({ success: false, reason: "allocator_conflict_exhausted" });
    expect(git.entries()).toEqual([]);
    expect(git.calls.filter(call => call.method === "PATCH")).toHaveLength(5);
  });

  it("does not retry a protected-branch refusal as a concurrency conflict", async () => {
    const git = new FakeGitHub();
    git.patchStatus = 422;
    expect(await git.allocate()).toMatchObject({ success: false, reason: "github_error" });
    expect(git.entries()).toEqual([]);
    expect(git.calls.filter(call => call.method === "PATCH")).toHaveLength(1);
  });

  it.each([
    ["missing alias", () => null],
    ["truncated blob", (blob: Record<string, unknown>) => ({ ...blob, isTruncated: true })],
    ["binary blob", (blob: Record<string, unknown>) => ({ ...blob, isBinary: true })],
    ["wrong oid", (blob: Record<string, unknown>) => ({ ...blob, oid: "0".repeat(40) })],
    ["wrong byte size", (blob: Record<string, unknown>) => ({ ...blob, byteSize: 0 })],
    ["missing text", (blob: Record<string, unknown>) => ({ ...blob, text: null })],
  ] as const)("rejects GraphQL %s without publishing any mutation", async (_label, patchBlob) => {
    const git = new FakeGitHub({ [POST_PATH]: post(233) });
    git.patchBlob = patchBlob;
    expect(await git.allocate()).toMatchObject({ success: false, reason: "invalid_allocator_state" });
    expect(git.calls.some(call => call.path !== "/graphql" && call.method !== "GET")).toBe(false);
  });

  it("rejects GraphQL partial errors even if all requested blobs are present", async () => {
    const git = new FakeGitHub({ [POST_PATH]: post(233) });
    git.graphErrors = true;
    expect(await git.allocate()).toMatchObject({ success: false, reason: "invalid_allocator_state" });
    expect(git.calls.some(call => call.path !== "/graphql" && call.method !== "GET")).toBe(false);
  });

  it("reads 217 historical posts in six bounded GraphQL batches", async () => {
    const files = Object.fromEntries(Array.from({ length: 217 }, (_, index) =>
      [`docs/2026/legacy/${index + 1}-1-club-2026-09-01.md`, post(index + 1)]));
    const git = new FakeGitHub(files);
    expect(await git.allocate()).toMatchObject({ success: true, post_number: 218 });
    const batches = git.calls.filter(call => call.path === "/graphql");
    expect(batches).toHaveLength(6);
    expect(batches.every(call => [...call.body.query.matchAll(/object\(oid:/g)].length <= 40)).toBe(true);
    expect(git.calls).toHaveLength(13);
  });

  it("rejects oversized historical content before requesting its text", async () => {
    const git = new FakeGitHub({ [POST_PATH]: post(233) });
    git.reportedSize = 1024 * 1024 + 1;
    expect(await git.allocate()).toMatchObject({ success: false, reason: "allocator_budget_exceeded" });
    expect(git.calls.some(call => call.method !== "GET")).toBe(false);
  });

  it("does not start a Git mutation once the overall deadline expires", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      const git = new FakeGitHub({ [POST_PATH]: post(233) });
      git.afterBlobBatch = () => controller.abort();
      expect(await git.allocate()).toMatchObject({ success: false, reason: "allocator_budget_exceeded" });
      expect(git.calls.some(call => call.path !== "/graphql" && call.method !== "GET")).toBe(false);
      expect(git.request.mock.calls.every(([, init]) => init?.signal === controller.signal)).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });

  it("does not write after wall time expires while the abort callback is still pending", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const git = new FakeGitHub({ [POST_PATH]: post(233) });
      git.afterBlobBatch = () => { clock.mockReturnValue(25_001); };
      expect(await git.allocate()).toMatchObject({ success: false, reason: "allocator_budget_exceeded" });
      expect(git.calls.some(call => call.path !== "/graphql" && call.method !== "GET")).toBe(false);
      expect(git.request.mock.calls.every(([, init]) => init?.signal?.aborted === false)).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects duplicate JSON keys instead of silently taking the last number", async () => {
    const raw = log(entry(233)).replace('"post_number":233', '"post_number":999,"post_number":233');
    const git = new FakeGitHub({ [ALLOCATOR_LOG_PATH]: raw });
    expect(await git.allocate()).toMatchObject({ success: false, reason: "invalid_allocator_state" });
    expect(git.calls.some(call => call.path !== "/graphql" && call.method !== "GET")).toBe(false);
  });

  it.each([undefined, 234])("does not reallocate a historical draft with missing/mismatched log entry (%s)", async number => {
    const git = new FakeGitHub({ [POST_PATH]: post(233, DRAFT_ID),
      ...(number === undefined ? {} : { [ALLOCATOR_LOG_PATH]: log(entry(number, DRAFT_ID)) }) });
    expect(await git.allocate()).toMatchObject({ success: false, reason: "post_number_ownership_conflict" });
    expect(git.calls.some(call => call.path !== "/graphql" && call.method !== "GET")).toBe(false);
  });

  it("returns on the deadline even if auth is pending and ignores its late result", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    let finishAuth!: (token: string) => void;
    const auth = new Promise<string>(resolve => { finishAuth = resolve; });
    const fetch = vi.fn();
    try {
      const allocation = allocatePostNumber(ENV, allocatorContext, knowledgeIndexTarget.source, DRAFT_ID, "post", {
        getInstallationToken: vi.fn().mockReturnValue(auth), fetch,
      });
      controller.abort();
      expect(await allocation).toMatchObject({ success: false, reason: "allocator_budget_exceeded" });
      finishAuth("late-test-token");
      await auth;
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });

  it("fails within its request cap rather than reaching a Worker subrequest limit", async () => {
    const files = Object.fromEntries(Array.from({ length: 1600 }, (_, index) =>
      [`docs/2026/legacy/${index + 1}-1-club-2026-09-01.md`, post(index + 1)]));
    const git = new FakeGitHub(files);
    expect(await git.allocate()).toMatchObject({ success: false, reason: "allocator_budget_exceeded" });
    expect(git.calls).toHaveLength(40);
    expect(git.calls.some(call => call.path !== "/graphql" && call.method !== "GET")).toBe(false);
  });

  it("refuses an overflowing counter", async () => {
    const git = new FakeGitHub({ [ALLOCATOR_LOG_PATH]: log(entry(Number.MAX_SAFE_INTEGER)) });
    expect(await git.allocate()).toMatchObject({ success: false, reason: "invalid_allocator_state" });
    expect(git.calls.some(call => call.path !== "/graphql" && call.method !== "GET")).toBe(false);
  });

  const scaffoldInput = { date: "2026-09-25", slug: "browser-draft", title: 'Заголовок с "кавычками"', channels: ["telegram", "club"] };
  const scaffoldRepository = (files: Record<string, string> = {}) => new FakeGitHub({
    [POST_CONVENTION_PATH]: JSON.stringify(POST_CONVENTION_FIXTURE), ...files,
  });

  it("atomically creates the reservation and all draft channel files after authorizing every path", async () => {
    const git = scaffoldRepository({ [POST_PATH]: post(233), [ALLOCATOR_LOG_PATH]: log(entry(232)) });
    git.authorizePaths.mockImplementation(async paths => {
      expect(paths).toHaveLength(3);
      expect(git.calls.some(call => call.path !== "/graphql" && call.method !== "GET")).toBe(false);
    });
    const result = await git.scaffold(scaffoldInput);
    expect(result).toMatchObject({ success: true, post_number: 234, reused: false, scaffold: { status: "created", commit_sha: git.head } });
    const paths = result.scaffold!.paths;
    expect(paths).toEqual([
      "docs/2026/04-сентябрь/14-09-2026-09-25-browser-draft/14-09-1-club-2026-09-25.md",
      "docs/2026/04-сентябрь/14-09-2026-09-25-browser-draft/14-09-4-telegram-2026-09-25.md",
    ]);
    expect(git.authorizePaths).toHaveBeenCalledWith([ALLOCATOR_LOG_PATH, ...paths]);
    expect(git.entries().map(value => value.post_number)).toEqual([232, 234]);
    expect(paths.every(path => git.files()[path].includes('status: "draft"'))).toBe(true);
    expect(git.files()[paths[1]]).toContain('source_post: "14-09-1-club-2026-09-25.md"');
    expect(git.calls.filter(call => call.method === "PATCH")).toHaveLength(1);
    expect(git.calls.find(call => call.method === "POST" && call.path === "/git/trees")!.body.tree).toHaveLength(3);
  });

  it("fills a browser scaffold through live SHA reads while the search index remains empty", async () => {
    const git = scaffoldRepository();
    const result = await git.scaffold(scaffoldInput);
    const filename = result.scaffold!.paths[0];
    expect(result.next_action).toContain("include_sha:true");
    queryQueue.push([{ installation_id: 42 }]);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/access_tokens") ? responseJson({ token: "fake-token" }) : git.request(input, init));
    const live = await personalGetDocumentWithSha(ENV_WITH_APP, allocatorContext, filename, knowledgeIndexTarget.source);
    expect(live?.kind).toBe("document");
    if (live?.kind !== "document") throw new Error("Expected live GitHub document");
    expect(sqlCalls).toHaveLength(1); // Installation metadata only; no knowledge.documents query.
    expect((sqlCalls[0][0] as TemplateStringsArray).join(" ")).toContain("installation_id");
    const edited = live.content + "\nГотовый текст автора.\n";
    const saved = await writeToGitHub(ENV, allocatorContext, knowledgeIndexTarget.source, filename, edited, "fill draft", {
      getInstallationToken: async () => "fake-token", fetch: git.request,
    }, live.sha);
    expect(saved.success).toBe(true);
    expect(git.files()[filename]).toBe(edited);
    expect(git.entries()).toHaveLength(1);
  });

  it("materializes a previous reservation without adding a second log entry", async () => {
    const initialLog = log(entry(233, DRAFT_ID));
    const git = scaffoldRepository({ [ALLOCATOR_LOG_PATH]: initialLog });
    expect(await git.scaffold(scaffoldInput)).toMatchObject({ success: true, post_number: 233, reused: true, scaffold: { status: "created" } });
    expect(git.files()[ALLOCATOR_LOG_PATH]).toBe(initialLog);
    expect(git.entries()).toHaveLength(1);
    expect(git.authorizePaths.mock.calls[0][0]).not.toContain(ALLOCATOR_LOG_PATH);
  });

  it("replays an existing scaffold without overwriting edited content or appending a reservation", async () => {
    const git = scaffoldRepository();
    const first = await git.scaffold(scaffoldInput);
    const club = first.scaffold!.paths[0];
    const edited = git.files()[club].replace('status: "draft"', 'status: "ready"') + "\nАвторский текст.\n";
    git.externalWrite(club, edited);
    const mutations = git.calls.filter(call => call.path !== "/graphql" && call.method !== "GET").length;
    const replay = await git.scaffold(scaffoldInput);
    expect(replay).toMatchObject({ success: true, reused: true, scaffold: { status: "existing", paths: first.scaffold!.paths } });
    expect(git.files()[club]).toBe(edited);
    expect(git.entries()).toHaveLength(1);
    expect(git.calls.filter(call => call.path !== "/graphql" && call.method !== "GET")).toHaveLength(mutations);
  });

  it.each([
    { title: "Другой заголовок" }, { slug: "different-draft" }, { date: "2026-09-26" },
    { channels: ["club"] }, { audience: "advanced" }, { content_plan: "changed" }, { related_wp: 560 },
  ])("rejects changed scaffold parameters on replay: %j", async changes => {
    const git = scaffoldRepository();
    await git.scaffold(scaffoldInput);
    const head = git.head;
    expect(await git.scaffold({ ...scaffoldInput, ...changes })).toMatchObject({ success: false, reason: "scaffold_conflict" });
    expect(git.head).toBe(head);
    expect(git.entries()).toHaveLength(1);
  });

  it.each([0, 1])("refuses to silently recreate a missing channel file on replay (index %s)", async index => {
    const git = scaffoldRepository();
    const first = await git.scaffold(scaffoldInput);
    git.externalDelete(first.scaffold!.paths[index]);
    const head = git.head;
    expect(await git.scaffold(scaffoldInput)).toMatchObject({ success: false, reason: "scaffold_conflict" });
    expect(git.head).toBe(head);
    expect(git.files()[first.scaffold!.paths[index]]).toBeUndefined();
  });

  it("leaves both log and files unpublished when the branch refuses the atomic update", async () => {
    const git = scaffoldRepository();
    const files = git.files();
    git.patchStatus = 403;
    expect(await git.scaffold(scaffoldInput)).toMatchObject({ success: false, reason: "github_error" });
    expect(git.files()).toEqual(files);
  });

  it("does not create any Git objects when path scope authorization denies a channel", async () => {
    const git = scaffoldRepository();
    git.authorizePaths.mockRejectedValue(new Error("scope denied: path_not_allowed"));
    expect(await git.scaffold(scaffoldInput)).toMatchObject({ success: false });
    expect(git.authorizePaths).toHaveBeenCalledTimes(1);
    expect(git.calls.some(call => call.path !== "/graphql" && call.method !== "GET")).toBe(false);
  });

  it("requires a path authorization callback before accessing GitHub for a scaffold", async () => {
    const fetch = vi.fn();
    expect(await createPersonalPost(ENV, allocatorContext, {
      source: knowledgeIndexTarget.source, draftId: DRAFT_ID, artifactType: "post", scaffold: scaffoldInput,
    }, { fetch })).toMatchObject({ success: false, reason: "path_authorization_required" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails without allocating when the shared convention is missing or unsupported", async () => {
    const fixtures: Array<Record<string, string>> = [{}, { [POST_CONVENTION_PATH]: JSON.stringify({ ...POST_CONVENTION_FIXTURE, version: 2 }) }];
    for (const files of fixtures) {
      const git = new FakeGitHub(files);
      expect(await git.scaffold(scaffoldInput)).toMatchObject({ success: false, reason: "invalid_post_convention" });
      expect(git.entries()).toEqual([]);
      expect(git.calls.some(call => call.path !== "/graphql" && call.method !== "GET")).toBe(false);
    }
  });

  it("rejects a reordered channel template that the version 1 allocator cannot discover", async () => {
    const changed = { ...POST_CONVENTION_FIXTURE, templates: { ...POST_CONVENTION_FIXTURE.templates,
      channel_file: "{channel_number}-{channel}-{date}-{sequence}-{month}.md" } };
    const git = scaffoldRepository({ [POST_CONVENTION_PATH]: JSON.stringify(changed) });
    expect(await git.scaffold(scaffoldInput)).toMatchObject({ success: false, reason: "invalid_post_convention" });
    expect(git.entries()).toEqual([]);
    expect(git.calls.some(call => call.path !== "/graphql" && call.method !== "GET")).toBe(false);
  });

  it("replans names and numbers when concurrent browser drafts race on the branch", async () => {
    const git = scaffoldRepository();
    const results = await Promise.all([
      git.scaffold(scaffoldInput, DRAFT_ID),
      git.scaffold({ ...scaffoldInput, slug: "second-draft" }, OTHER_DRAFT_ID),
    ]);
    expect(results.every(result => result.success)).toBe(true);
    expect(results.map(result => result.post_number).sort()).toEqual([1, 2]);
    const paths = results.flatMap(result => result.scaffold!.paths);
    expect(new Set(paths).size).toBe(4);
    expect(paths.every(path => !!git.files()[path])).toBe(true);
    expect(git.entries()).toHaveLength(2);
    expect(git.authorizePaths).toHaveBeenCalledTimes(3);
  });

  it("creates only one scaffold for concurrent requests with the same UUID", async () => {
    const git = scaffoldRepository();
    const [first, second] = await Promise.all([git.scaffold(scaffoldInput), git.scaffold(scaffoldInput)]);
    expect(first.success && second.success).toBe(true);
    expect(first.post_number).toBe(second.post_number);
    expect(first.scaffold!.paths).toEqual(second.scaffold!.paths);
    expect(git.entries()).toHaveLength(1);
  });

  it("reports no_installation without any repository request", async () => {
    const fetch = vi.fn();
    expect(await allocatePostNumber(ENV, allocatorContext, knowledgeIndexTarget.source, DRAFT_ID, "post", {
      getInstallationToken: vi.fn().mockResolvedValue(null), fetch,
    })).toMatchObject({ success: false, reason: "no_installation" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("writeToGitHub — optimistic concurrency (WP-7 Ф96, ported from personal-knowledge-mcp)", () => {
  const VALID_SHA = "a".repeat(40);

  it("proceeds to PUT when expectedSha matches the current GitHub sha", async () => {
    const calls = queuedFetch([
      ...installationTokenResponses(),
      responseJson({ sha: VALID_SHA }), // existing-content GET
      responseJson({ content: { sha: "b".repeat(40), html_url: "https://github.com/x" } }), // PUT
    ]);
    const result = await writeToGitHub(ENV_WITH_APP, ctx(), "DS-my-strategy", "notes/idea.md", "updated", "update", {}, VALID_SHA);
    expect(result.success).toBe(true);
    expect(calls.filter(c => c.method === "PUT")).toHaveLength(1);
  });

  it("refuses a stale expectedSha before issuing any PUT", async () => {
    const calls = queuedFetch([
      ...installationTokenResponses(),
      responseJson({ sha: VALID_SHA }), // GitHub's current sha differs from the caller's stale read
    ]);
    const result = await writeToGitHub(ENV_WITH_APP, ctx(), "DS-my-strategy", "notes/idea.md", "edited from stale read", "update", {}, "c".repeat(40));
    expect(result.success).toBe(false);
    expect(result.reason).toBe("version_mismatch");
    expect(result.current_sha).toBe(VALID_SHA);
    expect(calls.some(c => c.method === "PUT")).toBe(false);
  });

  it("keeps prior overwrite behavior when expectedSha is omitted", async () => {
    const calls = queuedFetch([
      ...installationTokenResponses(),
      responseJson({ sha: VALID_SHA }),
      responseJson({ content: { sha: "b".repeat(40), html_url: "https://github.com/x" } }),
    ]);
    const result = await writeToGitHub(ENV_WITH_APP, ctx(), "DS-my-strategy", "notes/idea.md", "updated", "update");
    expect(result.success).toBe(true);
    expect(calls.filter(c => c.method === "PUT")).toHaveLength(1);
  });

  it("normalizes a GitHub 409 on PUT to version_mismatch instead of a generic error", async () => {
    queuedFetch([
      ...installationTokenResponses(),
      responseJson({ sha: VALID_SHA }),
      responseJson({ message: "sha does not match" }, 409), // pre-check passed, then the PUT itself races and loses
    ]);
    const result = await writeToGitHub(ENV_WITH_APP, ctx(), "DS-my-strategy", "notes/idea.md", "racing write", "update", {}, VALID_SHA);
    expect(result.success).toBe(false);
    expect(result.reason).toBe("version_mismatch");
  });
});

// WP-7 Ф144, ported from personal-knowledge-mcp: a bare "indexing not confirmed
// yet" read as an open question to a weak tool-calling model (a LibreChat/
// DeepSeek session kept re-asking, hit a recursion limit). Pins the wording so
// a future edit can't silently reintroduce that ambiguity — the archived repo
// had this test, the canonical tree didn't.
describe("INDEXING_ASYNC_NOTICE wording (WP-7 Ф144)", () => {
  it("tells the caller no follow-up call is needed, not just that indexing is unconfirmed", () => {
    expect(INDEXING_ASYNC_NOTICE.status).toBe("async");
    expect(INDEXING_ASYNC_NOTICE.note).toContain("дальнейших действий не требуется");
    expect(INDEXING_ASYNC_NOTICE.note).not.toMatch(/^Запись подтверждена, но/);
  });
});

// getInstallationToken's signature changed from (env, owner) to (env, userId, repository)
// on 2026-08-31 (pagination fix, WP-7) — every other test here injects a fixed-return mock
// via `installationTokenResponses()`'s queryQueue side effect and never inspects call
// arguments, so a caller silently passing the wrong value (e.g. owner where userId belongs)
// would pass every other test in this file. These two pin the contract directly.
describe("getInstallationToken call contract (WP-7 2026-08-31 pagination fix)", () => {
  it("writeToGitHub calls getInstallationToken with (env, userId, repo) — not owner", async () => {
    const getInstallationToken = vi.fn().mockResolvedValue("ghs_test_token");
    const request = vi.fn()
      .mockResolvedValueOnce(responseJson({ message: "Not Found" }, 404)) // existence check: new file
      .mockResolvedValueOnce(responseJson({ content: { sha: "b".repeat(40), html_url: "https://github.com/x" } })); // PUT
    const result = await writeToGitHub(
      ENV, ctx(), "DS-my-strategy", "notes/idea.md", "hi", "msg",
      { getInstallationToken, fetch: request as unknown as typeof globalThis.fetch },
    );
    expect(result.success).toBe(true);
    expect(getInstallationToken).toHaveBeenCalledWith(ENV, ctx().userId, "DS-my-strategy");
  });

  it("deleteFromGitHub calls getInstallationToken with (env, userId, repo) — not owner", async () => {
    const getInstallationToken = vi.fn().mockResolvedValue("ghs_test_token");
    const request = vi.fn()
      .mockResolvedValueOnce(responseJson({ sha: "a".repeat(40) })) // GET existing
      .mockResolvedValueOnce(responseJson({})); // DELETE
    queryQueue.push([]); // post-delete document-index cleanup query
    const result = await deleteFromGitHub(
      ENV, ctx(), "DS-my-strategy", "notes/idea.md", "msg",
      { getInstallationToken, fetch: request as unknown as typeof globalThis.fetch },
    );
    expect(result.success).toBe(true);
    expect(getInstallationToken).toHaveBeenCalledWith(ENV, ctx().userId, "DS-my-strategy");
  });
});

describe("personalGetDocumentLive (WP-7 Ф96)", () => {
  it("returns content and sha from the same GitHub response", async () => {
    const original = "# Заголовок\n\nС юникодом.";
    const encoded = btoa(unescape(encodeURIComponent(original)));
    const sha = "d".repeat(40);
    queuedFetch([
      ...installationTokenResponses(),
      responseJson({ sha, content: encoded, encoding: "base64" }),
    ]);
    const doc = await personalGetDocumentLive(ENV_WITH_APP, ctx(), "notes/idea.md", "DS-my-strategy");
    expect(doc?.content).toBe(original);
    expect(doc?.sha).toBe(sha);
  });

  it("returns null for an unknown source without touching the network", async () => {
    queuedFetch([]);
    const doc = await personalGetDocumentLive(ENV_WITH_APP, ctx(), "notes/idea.md", "not-a-real-source");
    expect(doc).toBeNull();
  });

  it("returns null on a 404 from the Contents API", async () => {
    queuedFetch([...installationTokenResponses(), responseJson({ message: "Not Found" }, 404)]);
    const doc = await personalGetDocumentLive(ENV_WITH_APP, ctx(), "notes/missing.md", "DS-my-strategy");
    expect(doc).toBeNull();
  });

  it("returns null when the response is missing content/encoding", async () => {
    queuedFetch([...installationTokenResponses(), responseJson({ sha: "e".repeat(40) })]);
    const doc = await personalGetDocumentLive(ENV_WITH_APP, ctx(), "notes/idea.md", "DS-my-strategy");
    expect(doc).toBeNull();
  });
});

describe("connectSource", () => {
  const INSTALL_ROW = { github_username: "TserenTserenov", repos: ["DS-my-strategy"] };
  const REPO_ID = "987654321012"; // beyond 2^31 on purpose — BIGINT stays a string end to end

  /** GitHub App token + GET /repos/{owner}/{repo} → { id }. `id: null` = identity unverifiable. */
  function githubIdentity(id: number | string | null, ok = true) {
    const fetchMock = vi.fn(async () => id === null && ok
      ? responseJson({})
      : responseJson(ok ? { id } : { message: "Not Found" }, ok ? 200 : 404));
    return {
      fetchMock,
      dependencies: { getInstallationToken: vi.fn().mockResolvedValue("ghs_test_token"), fetch: fetchMock as unknown as typeof globalThis.fetch },
    };
  }

  function sqlTextContaining(fragment: string): string | undefined {
    return sqlCalls.map(([t]) => (t as TemplateStringsArray).join(" ")).find((s) => s.includes(fragment));
  }

  it("errors when the user has no GitHub App installation", async () => {
    queryQueue.push([]); // installRows empty
    const result = await connectSource(ENV, "user-1", "DS-my-strategy");
    expect(result.status).toBe("error");
    expect(result.error).toContain("GitHub App");
    expect(result.reindex_triggered).toBe(false);
  });

  it("errors when the source is not part of the installation", async () => {
    queryQueue.push([{ github_username: "TserenTserenov", repos: ["other-repo"] }]);
    const result = await connectSource(ENV, "user-1", "DS-my-strategy");
    expect(result.status).toBe("error");
    expect(result.error).toContain("не входит");
  });

  // github-integration-service cf8c3cf: rows written before its sql.json() fix store repos
  // as a jsonb *string* scalar (postgres.js quirk with JSON.stringify(x)::jsonb) instead of
  // an array. A bare `as string[]` cast let a lookup miss crash on repos.join() — the same
  // class of bug already fixed in personal-knowledge-mcp's connectSource, this is its "faithful
  // port" (see file header), so it carries the same defect and the same fix.
  it("self-heals a legacy string-encoded repos column instead of crashing", async () => {
    queryQueue.push([{ github_username: "TserenTserenov", repos: '["DS-my-strategy","DS-other"]' }]);
    queryQueue.push([]); // currentRows — no existing row → newly_connected
    queryQueue.push([{ user_id: "user-1" }]); // INSERT ... DO NOTHING RETURNING → inserted

    const result = await connectSource(ENV, "user-1", "DS-my-strategy", githubIdentity(1).dependencies);

    expect(result.status).toBe("newly_connected");
    expect(result.error).toBeUndefined();
  });

  it("reports a clean error, not a crash, when repos is a non-JSON string", async () => {
    queryQueue.push([{ github_username: "TserenTserenov", repos: "not-json" }]);
    const result = await connectSource(ENV, "user-1", "DS-my-strategy");
    expect(result.status).toBe("error");
    expect(result.error).toContain("нет ни одного");
  });

  it("connects a new source, provisions bridge scopes; reindex trigger is the caller's job (index.ts, группа В)", async () => {
    queryQueue.push([INSTALL_ROW]); // installRows
    queryQueue.push([]); // currentRows — no existing row → newly_connected
    queryQueue.push([{ user_id: "user-1" }]); // INSERT ... DO NOTHING RETURNING → inserted
    queryQueue.push([]); // provisionBridgeScopes INSERT

    const result = await connectSource(
      { ...ENV, INDICATORS_DATABASE_URL: "postgres://fake-indicators" },
      "user-1",
      "DS-my-strategy",
      githubIdentity(REPO_ID).dependencies,
    );

    expect(result.status).toBe("newly_connected");
    expect(result.scope_provisioning).toBe("ok");
    // connectSource() itself never calls startReindexJob (circular-import boundary with
    // reindex.ts) — the caller in index.ts does that and overwrites these two fields.
    expect(result.reindex_triggered).toBe(false);
    expect(result.message).toContain("права на запись выданы");
    expect(sqlTextContaining("(user_id, source, github_owner, github_repo, source_type, active, github_repository_id)")).toContain("ON CONFLICT (user_id, source) DO NOTHING");
  });

  it("skips scope provisioning (not fails the connect) when INDICATORS_DATABASE_URL is absent", async () => {
    queryQueue.push([INSTALL_ROW]);
    queryQueue.push([{ active: false, github_repository_id: REPO_ID, index_state: "ready" }]); // same identity, inactive → reactivate
    queryQueue.push([]); // UPDATE user_sources

    const result = await connectSource(ENV, "user-1", "DS-my-strategy", githubIdentity(Number(REPO_ID)).dependencies);

    expect(result.status).toBe("reactivated");
    expect(result.scope_provisioning).toBe("skipped");
    expect(result.reindex_triggered).toBe(false);
  });

  // --- WP-560 Ф3: repository-identity fingerprint ---

  it("refuses (fail-closed) when the repository identity cannot be verified through the App", async () => {
    queryQueue.push([INSTALL_ROW]);
    const { dependencies, fetchMock } = githubIdentity(null, false); // 404 from GET /repos
    const result = await connectSource(ENV, "user-1", "DS-my-strategy", dependencies);
    expect(result.status).toBe("error");
    expect(result.error).toContain("идентичность");
    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/repos/TserenTserenov/DS-my-strategy", expect.any(Object));
    expect(sqlCalls).toHaveLength(1); // only the installation lookup — nothing written, nothing read
  });

  it("refuses when GITHUB_APP credentials are missing (no token → no identity)", async () => {
    queryQueue.push([INSTALL_ROW]);
    const result = await connectSource(ENV, "user-1", "DS-my-strategy"); // real getInstallationToken → null without App env
    expect(result.status).toBe("error");
    expect(result.error).toContain("идентичность");
  });

  it("rebinds when the stored fingerprint differs: purge + bump + pending job in one transaction", async () => {
    queryQueue.push([INSTALL_ROW]);
    queryQueue.push([{ active: true, github_repository_id: "111", index_state: "ready" }]); // stored identity ≠ live
    queryQueue.push([]); // DELETE documents
    queryQueue.push([]); // DELETE file_index_status
    queryQueue.push([{ index_generation: 2 }]); // UPDATE ... RETURNING index_generation
    queryQueue.push([{ id: "job-rebind", generation: "2" }]); // INSERT reindex_jobs ... RETURNING

    const result = await connectSource(ENV, "user-1", "DS-my-strategy", githubIdentity(Number(REPO_ID)).dependencies);

    expect(result.status).toBe("rebound");
    expect(result.rebind_reason).toBe("fingerprint_mismatch");
    expect(result.reindex_job_id).toBe("job-rebind");
    expect(result.index_generation).toBe(2);
    expect(result.reindex_triggered).toBe(false); // index.ts starts the pre-created job
    expect(result.message).toContain("недоступен для чтения");
    expect(sqlTextContaining("DELETE FROM")).toBeDefined();
    expect(sqlTextContaining("index_generation = index_generation + 1")).toContain("index_state = 'reindexing'");
    expect(sqlTextContaining("(user_id, source, status, generation)")).toContain("SELECT");
  });

  it("compares the BIGINT identity as a string — a driver string equals the live numeric id", async () => {
    queryQueue.push([INSTALL_ROW]);
    queryQueue.push([{ active: true, github_repository_id: REPO_ID, index_state: "ready" }]); // driver returns BIGINT as string
    queryQueue.push([]); // UPDATE (COALESCE no-op)

    const result = await connectSource(ENV, "user-1", "DS-my-strategy", githubIdentity(Number(REPO_ID)).dependencies);

    expect(result.status).toBe("already_connected");
    expect(sqlTextContaining("DELETE FROM")).toBeUndefined();
  });

  it("legacy row without fingerprint but WITH documents is not trusted: fail-closed rebind", async () => {
    queryQueue.push([INSTALL_ROW]);
    queryQueue.push([{ active: true, github_repository_id: null, index_state: "ready" }]);
    queryQueue.push([{ cnt: 17 }]); // documents exist under the unverified binding
    queryQueue.push([]); // DELETE documents
    queryQueue.push([]); // DELETE file_index_status
    queryQueue.push([{ index_generation: 5 }]);
    queryQueue.push([{ id: "job-legacy", generation: 5 }]);

    const result = await connectSource(ENV, "user-1", "DS-my-strategy", githubIdentity(Number(REPO_ID)).dependencies);

    expect(result.status).toBe("rebound");
    expect(result.rebind_reason).toBe("legacy_unverified_with_documents");
    expect(result.reindex_job_id).toBe("job-legacy");
    expect(result.index_generation).toBe(5);
  });

  it("legacy row without fingerprint and without documents just gets bound (no purge)", async () => {
    queryQueue.push([INSTALL_ROW]);
    queryQueue.push([{ active: false, github_repository_id: null, index_state: "ready" }]);
    queryQueue.push([{ cnt: 0 }]); // no documents
    queryQueue.push([]); // UPDATE ... COALESCE(github_repository_id, ...)

    const result = await connectSource(ENV, "user-1", "DS-my-strategy", githubIdentity(Number(REPO_ID)).dependencies);

    expect(result.status).toBe("reactivated");
    expect(result.rebind_reason).toBeUndefined();
    expect(sqlTextContaining("COALESCE(github_repository_id")).toBeDefined();
    expect(sqlTextContaining("DELETE FROM")).toBeUndefined();
  });
});

describe("connectSource — review fixes (WP-560 Ф3, cold review 02.09)", () => {
  const INSTALL_ROW = { github_username: "TserenTserenov", repos: ["DS-my-strategy"] };
  const REPO_ID = "987654321012";
  function deps(id: number) {
    const fetchMock = vi.fn(async () => responseJson({ id }));
    return { getInstallationToken: vi.fn().mockResolvedValue("ghs_test_token"), fetch: fetchMock as unknown as typeof globalThis.fetch };
  }
  function sqlTexts(): string[] {
    return sqlCalls.map(([t]) => (t as TemplateStringsArray).join(" "));
  }

  it("same repository but index stuck in 'reindexing' → recovery job with a new generation, no purge", async () => {
    queryQueue.push([INSTALL_ROW]);
    queryQueue.push([{ active: true, github_repository_id: REPO_ID, index_state: "reindexing" }]);
    queryQueue.push([]); // findLiveReindexJob → nothing alive
    queryQueue.push([{ index_generation: 9 }]); // UPDATE ... RETURNING (no DELETEs before it)
    queryQueue.push([{ id: "job-recover", generation: 9 }]); // INSERT reindex_jobs

    const result = await connectSource(ENV, "user-1", "DS-my-strategy", deps(Number(REPO_ID)));

    expect(result.status).toBe("rebound");
    expect(result.rebind_reason).toBe("stuck_index_recovery");
    expect(result.reindex_job_id).toBe("job-recover");
    expect(result.index_generation).toBe(9);
    expect(result.message).toContain("повторная переиндексация");
    expect(sqlTexts().some((s) => s.includes("DELETE FROM"))).toBe(false);
    expect(sqlTexts().some((s) => s.includes("index_generation = index_generation + 1"))).toBe(true);
  });

  it("same repository, index 'failed' → same recovery path", async () => {
    queryQueue.push([INSTALL_ROW]);
    queryQueue.push([{ active: true, github_repository_id: REPO_ID, index_state: "failed" }]);
    queryQueue.push([]); // findLiveReindexJob → nothing alive
    queryQueue.push([{ index_generation: 3 }]);
    queryQueue.push([{ id: "job-recover-2", generation: 3 }]);
    const result = await connectSource(ENV, "user-1", "DS-my-strategy", deps(Number(REPO_ID)));
    expect(result.status).toBe("rebound");
    expect(result.rebind_reason).toBe("stuck_index_recovery");
  });

  it("reconnect DURING a live reindex does not restart it: no generation bump, points at the running job", async () => {
    queryQueue.push([INSTALL_ROW]);
    queryQueue.push([{ active: true, github_repository_id: REPO_ID, index_state: "reindexing" }]);
    queryQueue.push([{ id: "job-live" }]); // findLiveReindexJob → running with fresh heartbeat
    queryQueue.push([]); // UPDATE ... COALESCE (plain reconnect)

    const result = await connectSource(ENV, "user-1", "DS-my-strategy", deps(Number(REPO_ID)));

    expect(result.status).toBe("already_connected");
    expect(result.rebind_reason).toBeUndefined();
    expect(result.reindex_job_id).toBe("job-live");
    expect(result.message).toContain("job-live");
    expect(sqlTexts().some((s) => s.includes("index_generation = index_generation + 1"))).toBe(false);
    const live = sqlTexts().find((s) => s.includes("last_heartbeat_at >"));
    expect(live).toContain("status = 'pending'");
    // WP-545 Ф13 cold review: findLiveReindexJob must scope to kind='full' — a running
    // incremental (webhook push) job is not "a rebuild in flight" and must not be mistaken
    // for one by this check (or a dropped filter here would silently pass, since the mocked
    // rows above never carry a `kind` column to begin with).
    expect(live).toContain("kind = 'full'");
  });

  it("losing a first-connect race does not overwrite the winner's identity: re-reads the row and reconciles", async () => {
    queryQueue.push([INSTALL_ROW]);
    queryQueue.push([]); // currentRows — none yet
    queryQueue.push([]); // INSERT ... DO NOTHING RETURNING → conflict, nothing inserted
    queryQueue.push([{ active: true, github_repository_id: "111", index_state: "ready" }]); // winner bound another repo id
    queryQueue.push([]); // DELETE documents
    queryQueue.push([]); // DELETE status
    queryQueue.push([{ index_generation: 2 }]);
    queryQueue.push([{ id: "job-race", generation: 2 }]);

    const result = await connectSource(ENV, "user-1", "DS-my-strategy", deps(Number(REPO_ID)));

    expect(result.status).toBe("rebound");
    expect(result.rebind_reason).toBe("fingerprint_mismatch");
    expect(sqlTexts().some((s) => s.includes("DO UPDATE SET"))).toBe(false); // no silent identity overwrite
  });
});

describe("resolveUserContext read gate (WP-560 Ф3)", () => {
  it("readers only see active sources whose index is ready", async () => {
    queryQueue.push([]);
    await resolveUserContext(ENV, "user-1");
    const text = (sqlCalls[0][0] as TemplateStringsArray).join(" ");
    expect(text).toContain("active = true");
    expect(text).toContain("index_state = 'ready'");
    expect(sqlCalls[0][3]).toBe(false); // params: [table, userId, includeReindexing]
  });

  it("the indexer opts in to sources that are being rebuilt", async () => {
    queryQueue.push([]);
    await resolveUserContext(ENV, "user-1", { includeReindexing: true });
    expect(sqlCalls[0][3]).toBe(true);
  });
});

// Деплой-2 группа А (peer-session 2026-07-01-29): faithful port from
// personal-knowledge-mcp/src/index.ts disconnectSource/purgeSource.
describe("disconnectSource", () => {
  it("reports already_disconnected with 0 kept docs when the source was never connected", async () => {
    queryQueue.push([]); // currentRows — no row found
    const result = await disconnectSource(ENV, "user-1", "DS-my-strategy");
    expect(result.status).toBe("already_disconnected");
    expect(result.documents_kept).toBe(0);
    expect(result.error).toContain("не подключён");
  });

  it("reports already_disconnected with kept doc count when the source is already inactive", async () => {
    queryQueue.push([{ active: false }]); // currentRows
    queryQueue.push([{ cnt: 4 }]); // documents count
    const result = await disconnectSource(ENV, "user-1", "DS-my-strategy");
    expect(result.status).toBe("already_disconnected");
    expect(result.documents_kept).toBe(4);
  });

  it("flips active=false and keeps documents when disconnecting an active source", async () => {
    queryQueue.push([{ active: true }]); // currentRows
    queryQueue.push([]); // UPDATE user_sources
    queryQueue.push([{ cnt: 12 }]); // documents count after update
    const result = await disconnectSource(ENV, "user-1", "DS-my-strategy");
    expect(result.status).toBe("disconnected");
    expect(result.documents_kept).toBe(12);
  });
});

describe("purgeSource", () => {
  it("reports not_found when the source has no user_sources row", async () => {
    queryQueue.push([]); // sourceRows — no match
    const result = await purgeSource(ENV, "user-1", "DS-my-strategy");
    expect(result.status).toBe("not_found");
    expect(result.documents_deleted).toBe(0);
    expect(result.jobs_deleted).toBe(0);
  });

  it("deletes documents, reindex_jobs, and the user_sources row (irreversible)", async () => {
    queryQueue.push([{ source: "DS-my-strategy" }]); // sourceRows — found
    queryQueue.push([{ cnt: 7 }]); // documents DELETE...RETURNING count
    queryQueue.push([{ cnt: 2 }]); // reindex_jobs DELETE...RETURNING count
    queryQueue.push([]); // final DELETE user_sources
    const result = await purgeSource(ENV, "user-1", "DS-my-strategy");
    expect(result.status).toBe("purged");
    expect(result.documents_deleted).toBe(7);
    expect(result.jobs_deleted).toBe(2);
  });
});

describe("canonicalContentsPath (WP-7 Ф96 rework — safe live-read path)", () => {
  it("encodes each segment and joins with the prefix", () => {
    expect(canonicalContentsPath("archive", "docs/мой файл#1.md")).toBe("archive/docs/%D0%BC%D0%BE%D0%B9%20%D1%84%D0%B0%D0%B9%D0%BB%231.md");
    expect(canonicalContentsPath("", "docs/plain.md")).toBe("docs/plain.md");
  });

  it("collapses dot segments and duplicate separators", () => {
    expect(canonicalContentsPath("", "docs//./sub/../plain.md")).toBe("docs/plain.md");
  });

  it("rejects escape attempts, absolute paths, backslashes and NUL", () => {
    for (const bad of ["../up.md", "a/../../up.md", "/abs.md", "a\\b.md", "a\0b.md", ""]) {
      expect(() => canonicalContentsPath("archive", bad), bad).toThrow();
    }
  });
});

describe("personalGetDocumentWithSha (WP-7 Ф96 rework — live-first)", () => {
  const LIVE_SHA = "f".repeat(40);
  function liveBody() {
    return responseJson({ sha: LIVE_SHA, content: btoa(unescape(encodeURIComponent("live body"))), encoding: "base64" });
  }

  it("reads GitHub directly when source is given, without querying the index", async () => {
    const calls = queuedFetch([...installationTokenResponses(), liveBody()]);
    const result = await personalGetDocumentWithSha(ENV_WITH_APP, ctx(), "notes/idea.md", "DS-my-strategy");
    expect(result?.kind).toBe("document");
    if (result?.kind !== "document") throw new Error("unreachable");
    expect(result.sha).toBe(LIVE_SHA);
    expect(result.content).toBe("live body");
    expect(queryQueue.length).toBe(0); // nothing pre-queued, nothing consumed — index untouched
    expect(calls.filter(c => c.url.includes("/contents/")).length).toBe(1);
  });

  it("survives an index miss when the user has exactly one source (the stale-index scenario)", async () => {
    // A single connected source resolves before the index is ever consulted
    // (personalGetDocumentWithSha's early-return branch) — no index queries
    // happen in this scenario, only the installation-token lookup below.
    queuedFetch([...installationTokenResponses(), liveBody()]);
    const result = await personalGetDocumentWithSha(ENV_WITH_APP, ctx(), "notes/brand-new.md");
    expect(result?.kind).toBe("document");
  });

  it("returns source_required on an index miss with several sources", async () => {
    queryQueue.push([]); // ambiguity pre-check
    queryQueue.push([]); // v2 query
    queryQueue.push([]); // legacy fallback
    queuedFetch([]);
    const twoSources = ctx({ sourceNames: ["DS-my-strategy", "DS-other"] });
    const result = await personalGetDocumentWithSha(ENV_WITH_APP, twoSources, "notes/unknown.md");
    expect(result?.kind).toBe("source_required");
    if (result?.kind !== "source_required") throw new Error("unreachable");
    expect(result.sources).toEqual(["DS-my-strategy", "DS-other"]);
  });

  it("strips a legacy ::chunk suffix before the live read", async () => {
    const calls = queuedFetch([...installationTokenResponses(), liveBody()]);
    const result = await personalGetDocumentWithSha(ENV_WITH_APP, ctx(), "notes/idea.md::000001::intro", "DS-my-strategy");
    expect(result?.kind).toBe("document");
    const contentsCall = calls.find(c => c.url.includes("/contents/"));
    expect(contentsCall?.url.endsWith("/contents/notes/idea.md")).toBe(true);
  });
});

describe("writeToGitHub — expected_sha validation and 422 mapping (WP-7 Ф96 rework)", () => {
  const CUR_SHA = "a".repeat(40);

  it("refuses a malformed expected_sha as invalid_expected_sha before any PUT", async () => {
    for (const bad of ["", "abc", "z".repeat(40)]) {
      const calls = queuedFetch([...installationTokenResponses(), responseJson({ sha: CUR_SHA })]);
      const result = await writeToGitHub(ENV_WITH_APP, ctx(), "DS-my-strategy", "notes/idea.md", "content", "update", {}, bad);
      expect(result.success).toBe(false);
      expect(result.reason, JSON.stringify(bad)).toBe("invalid_expected_sha");
      expect(calls.some(c => c.method === "PUT")).toBe(false);
    }
  });

  it("maps a 422 without sha in the message to github_validation_error, not version_mismatch", async () => {
    queuedFetch([
      ...installationTokenResponses(),
      responseJson({ sha: CUR_SHA }),
      responseJson({ message: "path contains a malformed segment" }, 422),
    ]);
    const result = await writeToGitHub(ENV_WITH_APP, ctx(), "DS-my-strategy", "notes/idea.md", "content", "update", {}, CUR_SHA);
    expect(result.success).toBe(false);
    expect(result.reason).toBe("github_validation_error");
  });

  it("still maps a 422 that names the sha to version_mismatch", async () => {
    queuedFetch([
      ...installationTokenResponses(),
      responseJson({ sha: CUR_SHA }),
      responseJson({ message: '"sha" wasn\'t supplied' }, 422),
    ]);
    const result = await writeToGitHub(ENV_WITH_APP, ctx(), "DS-my-strategy", "notes/idea.md", "content", "update", {}, CUR_SHA);
    expect(result.success).toBe(false);
    expect(result.reason).toBe("version_mismatch");
  });
});

describe("canonicalContentsPath — malicious pathPrefix (WP-7 Ф96 round-2)", () => {
  it("rejects a prefix that escapes or carries forbidden characters", () => {
    for (const badPrefix of ["../private", "a/../../private", "a\\b", "a\0b"]) {
      expect(() => canonicalContentsPath(badPrefix, "docs/ok.md"), badPrefix).toThrow();
    }
  });

  it("still accepts a benign prefix with redundant separators", () => {
    expect(canonicalContentsPath("archive//sub/", "doc.md")).toBe("archive/sub/doc.md");
  });
});

describe("writeToGitHub — sha case and length edge cases (WP-7 Ф96 round-2)", () => {
  const CUR_SHA = "a".repeat(40);

  it("accepts an uppercase expected_sha for a lowercase GitHub sha — same version, not a conflict", async () => {
    const calls = queuedFetch([
      ...installationTokenResponses(),
      responseJson({ sha: CUR_SHA }),
      responseJson({ content: { sha: "b".repeat(40), html_url: "https://github.com/x" } }),
    ]);
    const result = await writeToGitHub(ENV_WITH_APP, ctx(), "DS-my-strategy", "notes/idea.md", "content", "update", {}, CUR_SHA.toUpperCase());
    expect(result.success).toBe(true);
    expect(calls.filter(c => c.method === "PUT")).toHaveLength(1);
  });

  it("rejects sha lengths 41 and 63 as invalid_expected_sha", async () => {
    for (const bad of ["a".repeat(41), "a".repeat(63)]) {
      queuedFetch([...installationTokenResponses(), responseJson({ sha: CUR_SHA })]);
      const result = await writeToGitHub(ENV_WITH_APP, ctx(), "DS-my-strategy", "notes/idea.md", "content", "update", {}, bad);
      expect(result.reason, String(bad.length)).toBe("invalid_expected_sha");
      vi.unstubAllGlobals();
    }
  });
});

describe("personalGetDocumentLive — sha shape validation (WP-7 Ф96 round-2)", () => {
  it("returns null when GitHub hands back a malformed sha", async () => {
    queuedFetch([
      ...installationTokenResponses(),
      responseJson({ sha: "not-a-real-sha", content: btoa("x"), encoding: "base64" }),
    ]);
    const doc = await personalGetDocumentLive(ENV_WITH_APP, ctx(), "notes/idea.md", "DS-my-strategy");
    expect(doc).toBeNull();
  });
});

describe("personalGetDocumentWithSha — single source bypasses the index entirely (WP-7 Ф96 round-2)", () => {
  it("performs the live read with zero index queries for a single-source user", async () => {
    const LIVE_SHA = "e".repeat(40);
    queuedFetch([
      ...installationTokenResponses(),
      responseJson({ sha: LIVE_SHA, content: btoa(unescape(encodeURIComponent("body"))), encoding: "base64" }),
    ]);
    // No queryQueue entries prepared: any index query would consume from an
    // empty queue and (worse) prove the index is still on the critical path.
    const result = await personalGetDocumentWithSha(ENV_WITH_APP, ctx(), "notes/brand-new.md");
    expect(result?.kind).toBe("document");
    expect(queryQueue.length).toBe(0);
  });
});

describe("writeToGitHub — warn-режим при перезаписи без expected_sha (решение 30.08)", () => {
  const CUR = "a".repeat(40);

  it("overwrite of an existing file without expected_sha succeeds with an explicit warning", async () => {
    queuedFetch([
      ...installationTokenResponses(),
      responseJson({ sha: CUR }),
      responseJson({ content: { sha: "b".repeat(40), html_url: "https://github.test/x" } }),
    ]);
    const result = await writeToGitHub(ENV_WITH_APP, ctx(), "DS-my-strategy", "notes/idea.md", "update", "update");
    expect(result.success).toBe(true);
    expect(result.warning).toMatch(/expected_sha не передан/);
  });

  it("creating a new file carries no warning", async () => {
    queuedFetch([
      ...installationTokenResponses(),
      { ok: false, status: 404 } as Response,
      responseJson({ content: { sha: "b".repeat(40), html_url: "https://github.test/x" } }),
    ]);
    const result = await writeToGitHub(ENV_WITH_APP, ctx(), "DS-my-strategy", "notes/new.md", "body", "create");
    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it("update with a matching expected_sha carries no warning", async () => {
    queuedFetch([
      ...installationTokenResponses(),
      responseJson({ sha: CUR }),
      responseJson({ content: { sha: "b".repeat(40), html_url: "https://github.test/x" } }),
    ]);
    const result = await writeToGitHub(ENV_WITH_APP, ctx(), "DS-my-strategy", "notes/idea.md", "update", "update", {}, CUR);
    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
  });
});
