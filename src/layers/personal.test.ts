// Tests for the private-mode personal-corpus data layer (WP-410 срез-2b).
// Ported logic (search/get_document/list_sources/memory_search/connect_source/delete) is
// exercised against a mocked neon() tag function — no live Neon connection.

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  encodeGitHubContentsPath,
  getPersonalWriteCreationBlock,
  isManagedKnowledgeIndexPostPath,
  KNOWLEDGE_INDEX_POST_CREATION_BLOCK,
  normalizeRepositoryPath,
  connectSource,
  deleteFromGitHub,
  writeToGitHub,
  personalListSources,
  personalGetDocument,
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
  it("normalizes separators, dot segments, duplicate slashes, and Unicode", () => {
    expect(normalizeRepositoryPath("./docs//2026\\draft/../cafe\u0301.md")).toBe(
      "docs/2026/café.md",
    );
  });

  it("rejects paths that escape the repository root", () => {
    expect(() => normalizeRepositoryPath("../../docs/2026/post.md")).toThrow("must not escape");
  });
});

describe("Knowledge Index publication creation guard", () => {
  const postPath = "docs/2026/05-август/40-08-2026-08-27-topic/40-08-1-club-2026-08-27.md";

  it("recognizes a normalized year-based Markdown publication path", () => {
    expect(isManagedKnowledgeIndexPostPath(
      knowledgeIndexTarget,
      `./docs//2026\\05-август/../05-август/${postPath.split("/").at(-1)}`,
    )).toBe(true);
  });

  it("rejects creation when GitHub did not confirm an existing SHA", () => {
    expect(getPersonalWriteCreationBlock(knowledgeIndexTarget, postPath)).toBe(KNOWLEDGE_INDEX_POST_CREATION_BLOCK);
    expect(getPersonalWriteCreationBlock(knowledgeIndexTarget, postPath, "not-a-git-sha")).toBe(KNOWLEDGE_INDEX_POST_CREATION_BLOCK);
    expect(KNOWLEDGE_INDEX_POST_CREATION_BLOCK).toContain("scripts/new-post.py");
    expect(KNOWLEDGE_INDEX_POST_CREATION_BLOCK).toContain("ASCII/manual fallback");
  });

  it("allows updates to an existing publication", () => {
    expect(getPersonalWriteCreationBlock(knowledgeIndexTarget, postPath, "a".repeat(40))).toBeUndefined();
  });

  it("does not block non-publication paths or a different resolved repository", () => {
    const otherTarget = { githubOwner: "TserenTserenov", githubRepo: "DS-my-strategy" };
    expect(getPersonalWriteCreationBlock(knowledgeIndexTarget, "docs/research/2026-08-study.md")).toBeUndefined();
    expect(getPersonalWriteCreationBlock(knowledgeIndexTarget, "docs/README.md")).toBeUndefined();
    expect(getPersonalWriteCreationBlock(otherTarget, "docs/2026/note.md")).toBeUndefined();
  });

  it("blocks an aliased personal_write at the fetch boundary without issuing PUT", async () => {
    const { request, dependencies } = githubDependencies([{ ok: false, status: 404 }]);
    const targetContext = ctx({ sources: [knowledgeIndexTarget], sourceNames: [knowledgeIndexTarget.source] });
    const expectedUrl = "https://api.github.com/repos/TserenTserenov/DS-Knowledge-Index-Tseren/contents/" +
      "docs/2026/05-%D0%B0%D0%B2%D0%B3%D1%83%D1%81%D1%82/40-08-2026-08-27-topic/40-08-1-club-2026-08-27.md";

    const result = await writeToGitHub(
      ENV,
      targetContext,
      knowledgeIndexTarget.source,
      postPath,
      "# post",
      "create post",
      dependencies,
    );

    expect(result).toEqual({ success: false, error: KNOWLEDGE_INDEX_POST_CREATION_BLOCK });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expectedUrl,
      expect.not.objectContaining({ method: "PUT" }),
    );
  });

  it("fails closed with scaffold instructions when the existence check is unavailable", async () => {
    const request = vi.fn().mockRejectedValue(new Error("GitHub unavailable"));
    const targetContext = ctx({ sources: [knowledgeIndexTarget], sourceNames: [knowledgeIndexTarget.source] });

    const result = await writeToGitHub(
      ENV,
      targetContext,
      knowledgeIndexTarget.source,
      postPath,
      "# post",
      "create post",
      {
        getInstallationToken: vi.fn().mockResolvedValue("ghs_test_token"),
        fetch: request as unknown as typeof globalThis.fetch,
      },
    );

    expect(result).toEqual({ success: false, error: KNOWLEDGE_INDEX_POST_CREATION_BLOCK });
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
      "# updated post",
      "update post",
      dependencies,
    );

    expect(result.success).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toBe(
      "https://api.github.com/repos/TserenTserenov/DS-Knowledge-Index-Tseren/contents/" +
      "docs/2026/05-%D0%B0%D0%B2%D0%B3%D1%83%D1%81%D1%82/40-08-2026-08-27-topic/40-08-1-club-2026-08-27.md",
    );
    expect(request.mock.calls[1][1]).toEqual(expect.objectContaining({ method: "PUT" }));
    expect(JSON.parse((request.mock.calls[1][1] as RequestInit).body as string)).toEqual(expect.objectContaining({ sha: existingSha }));
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
    queryQueue.push([]);
    const doc = await personalGetDocument(ENV, ctx(), "missing.md");
    expect(doc).toBeNull();
  });

  it("returns the document content and a resolved github_url for a known source", async () => {
    queryQueue.push([{ filename: "notes/idea.md", content: "hello", source: "DS-my-strategy", source_type: "ds" }]);
    const doc = await personalGetDocument(ENV, ctx(), "notes/idea.md");
    expect(doc?.content).toBe("hello");
    expect(doc?.github_url).toContain("github.com/TserenTserenov/DS-my-strategy");
  });
});

describe("deleteFromGitHub", () => {
  it("rejects an unknown source without touching the network", async () => {
    const result = await deleteFromGitHub(ENV, ctx(), "not-a-real-source", "notes/idea.md", "delete");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown source");
  });

  it("uses the exact encoded Contents API URL for Cyrillic delete paths", async () => {
    const sha = "c".repeat(40);
    const { request, dependencies } = githubDependencies([
      { ok: true, status: 200, json: async () => ({ sha }) },
      { ok: true, status: 200 },
    ]);
    queryQueue.push([]); // indexed document cleanup
    const path = "notes/05-август/файл #1.md";

    const result = await deleteFromGitHub(ENV, ctx(), "DS-my-strategy", path, "delete", dependencies);

    expect(result.success).toBe(true);
    const expectedUrl = "https://api.github.com/repos/TserenTserenov/DS-my-strategy/contents/" +
      "notes/05-%D0%B0%D0%B2%D0%B3%D1%83%D1%81%D1%82/%D1%84%D0%B0%D0%B9%D0%BB%20%231.md";
    expect(request.mock.calls[0][0]).toBe(expectedUrl);
    expect(request.mock.calls[1][0]).toBe(expectedUrl);
    expect(request.mock.calls[1][1]).toEqual(expect.objectContaining({ method: "DELETE" }));
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
