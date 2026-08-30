// Tests for the private-mode personal-corpus data layer (WP-410 срез-2b).
// Ported logic (search/get_document/list_sources/memory_search/connect_source/delete) is
// exercised against a mocked neon() tag function — no live Neon connection.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";

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
  };
  sql.unsafe = (v: string) => v;
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
  connectSource,
  deleteFromGitHub,
  writeToGitHub,
  personalListSources,
  personalGetDocument,
  personalGetDocumentLive,
  personalGetDocumentWithSha,
  disconnectSource,
  purgeSource,
  type UserContext,
  type PersonalEnv,
} from "./personal.js";
import { normalizePath as normalizeScopePath } from "../scope.js";

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

/** getInstallationToken() (personal.ts:197) always issues these two calls
 * first, in this order, before any Contents API call. */
function installationTokenResponses(): Response[] {
  return [
    responseJson([{ id: 42, account: { login: "TserenTserenov" } }]), // GET /app/installations
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
    expect(result.indexing).toEqual({ status: "async", note: expect.stringContaining("индексация для поиска идёт фоново") });
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
    queryQueue.push([]); // INSERT user_sources

    const result = await connectSource(ENV, "user-1", "DS-my-strategy");

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
    queryQueue.push([{ github_username: "TserenTserenov", repos: ["DS-my-strategy"] }]); // installRows
    queryQueue.push([]); // currentRows — no existing row → newly_connected
    queryQueue.push([]); // INSERT user_sources
    queryQueue.push([]); // provisionBridgeScopes INSERT

    const result = await connectSource(
      { ...ENV, INDICATORS_DATABASE_URL: "postgres://fake-indicators" },
      "user-1",
      "DS-my-strategy"
    );

    expect(result.status).toBe("newly_connected");
    expect(result.scope_provisioning).toBe("ok");
    // connectSource() itself never calls startReindexJob (circular-import boundary with
    // reindex.ts) — the caller in index.ts does that and overwrites these two fields.
    expect(result.reindex_triggered).toBe(false);
    expect(result.message).toContain("права на запись выданы");
  });

  it("skips scope provisioning (not fails the connect) when INDICATORS_DATABASE_URL is absent", async () => {
    queryQueue.push([{ github_username: "TserenTserenov", repos: ["DS-my-strategy"] }]);
    queryQueue.push([{ active: false }]); // currentRows — reactivate path
    queryQueue.push([]); // UPDATE user_sources

    const result = await connectSource(ENV, "user-1", "DS-my-strategy");

    expect(result.status).toBe("reactivated");
    expect(result.scope_provisioning).toBe("skipped");
    expect(result.reindex_triggered).toBe(false);
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
    queryQueue.push([]); // ambiguity pre-check
    queryQueue.push([]); // v2 query — miss
    queryQueue.push([]); // legacy fallback — miss
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
