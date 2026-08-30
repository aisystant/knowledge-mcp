// Tests for the private-mode personal-corpus data layer (WP-410 срез-2b).
// Ported logic (search/get_document/list_sources/memory_search/connect_source/delete) is
// exercised against a mocked neon() tag function — no live Neon connection.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";

let queryQueue: unknown[][] = [];

function nextSqlResult(): unknown[] {
  return queryQueue.shift() ?? [];
}

function makeMockSql() {
  const sql = ((..._args: unknown[]) => Promise.resolve(nextSqlResult())) as unknown as {
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
  connectSource,
  deleteFromGitHub,
  writeToGitHub,
  personalListSources,
  personalGetDocument,
  personalGetDocumentLive,
  disconnectSource,
  purgeSource,
  type UserContext,
  type PersonalEnv,
} from "./personal.js";

beforeEach(() => {
  queryQueue = [];
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
});

describe("writeToGitHub — optimistic concurrency (WP-7 Ф96, ported from personal-knowledge-mcp)", () => {
  const VALID_SHA = "a".repeat(40);

  it("proceeds to PUT when expectedSha matches the current GitHub sha", async () => {
    const calls = queuedFetch([
      ...installationTokenResponses(),
      responseJson({ sha: VALID_SHA }), // existing-content GET
      responseJson({ content: { sha: "b".repeat(40), html_url: "https://github.com/x" } }), // PUT
    ]);
    const result = await writeToGitHub(ENV_WITH_APP, ctx(), "DS-my-strategy", "notes/idea.md", "updated", "update", VALID_SHA);
    expect(result.success).toBe(true);
    expect(calls.filter(c => c.method === "PUT")).toHaveLength(1);
  });

  it("refuses a stale expectedSha before issuing any PUT", async () => {
    const calls = queuedFetch([
      ...installationTokenResponses(),
      responseJson({ sha: VALID_SHA }), // GitHub's current sha differs from the caller's stale read
    ]);
    const result = await writeToGitHub(ENV_WITH_APP, ctx(), "DS-my-strategy", "notes/idea.md", "edited from stale read", "update", "c".repeat(40));
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
    const result = await writeToGitHub(ENV_WITH_APP, ctx(), "DS-my-strategy", "notes/idea.md", "racing write", "update", VALID_SHA);
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
