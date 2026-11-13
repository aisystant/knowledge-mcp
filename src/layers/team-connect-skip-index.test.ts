// WP-560 Ф18: a free (no subscription) team connection reads and writes without a search index.
// connectTeamSource is exercised against a mocked neon() tag function; the GitHub checks
// (active binding, live permission) are stubbed because team-github.test.ts covers them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let queryQueue: unknown[][] = [];
let sqlTexts: string[] = [];

function makeMockSql() {
  const sql = ((strings: TemplateStringsArray | string) => {
    sqlTexts.push(typeof strings === "string" ? strings : strings.join("?"));
    return Promise.resolve(queryQueue.shift() ?? []);
  }) as unknown as {
    (..._args: unknown[]): Promise<unknown[]>;
    unsafe: (v: string) => string;
    transaction: (queries: Promise<unknown>[]) => Promise<unknown[]>;
  };
  sql.unsafe = (v: string) => v;
  sql.transaction = (queries: Promise<unknown>[]) => Promise.all(queries);
  return sql;
}

vi.mock("@neondatabase/serverless", () => ({ neon: vi.fn(() => makeMockSql()) }));

vi.mock("./team-github.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./team-github.js")>()),
  activeTeamBinding: vi.fn(async () => ({ repositoryId: 77, installationId: 9, owner: "acme", repository: "notes", generation: 1 })),
  issueTeamToken: vi.fn(async () => ({ token: "t", repositoryId: 77, repository: "acme/notes", visibility: "private", generation: 1, release: async () => true })),
}));

import { connectSource, type PersonalEnv } from "./personal.js";

const env = { DATABASE_URL: "postgres://test", GITHUB_TEAM_REPOS_ENABLED: "true" } as unknown as PersonalEnv;

function existingRow(row: Record<string, unknown> | null): void {
  // First transaction: set_config, then the SELECT of the current user_sources row.
  queryQueue.push([], row ? [row] : []);
}

const writes = () => sqlTexts.filter((text) => /INSERT|UPDATE|DELETE/.test(text));

describe("team connect with skip_index (free path)", () => {
  beforeEach(() => {
    queryQueue = [];
    sqlTexts = [];
  });
  afterEach(() => vi.restoreAllMocks());

  it("connects a new team source as ready, with no reindex job and no push-reindex subscription", async () => {
    existingRow(null);
    const result = await connectSource(env, "user-1", "acme/notes", {}, { skipIndex: true });
    expect(result).toMatchObject({ source: "acme/notes", status: "connected_without_index", reindex_triggered: false });
    expect(result.reindex_job_id).toBeUndefined();
    const sqlWrites = writes().join("\n");
    expect(sqlWrites).toContain("'ready'");
    expect(sqlWrites).not.toMatch(/INSERT INTO knowledge\.github_team_reindex_subscriptions/);
    expect(sqlWrites).not.toMatch(/INSERT INTO \S*reindex_jobs/);
    expect(sqlWrites).toMatch(/UPDATE knowledge\.github_team_reindex_subscriptions SET active = false/);
  });

  it("is a no-op for a source that is already connected to the same repository", async () => {
    existingRow({ github_repository_id: 77, github_user_binding_id: 77, active: true, index_state: "ready", indexed: false });
    const result = await connectSource(env, "user-1", "acme/notes", {}, { skipIndex: true });
    expect(result.status).toBe("already_connected");
    expect(writes()).toEqual([]);
  });

  it("does not leave a source stuck in reindexing when no indexing job is alive", async () => {
    existingRow({ github_repository_id: 77, github_user_binding_id: 77, active: true, index_state: "reindexing", indexed: true });
    queryQueue.push([]); // no pending/running job
    const result = await connectSource(env, "user-1", "acme/notes", {}, { skipIndex: true });
    expect(result.status).toBe("connected_without_index");
    expect(writes().join("\n")).toContain("'ready'");
  });

  it("keeps a source that is being indexed by a live job", async () => {
    existingRow({ github_repository_id: 77, github_user_binding_id: 77, active: true, index_state: "reindexing", indexed: true });
    queryQueue.push([{ id: "job-live" }]);
    const result = await connectSource(env, "user-1", "acme/notes", {}, { skipIndex: true });
    expect(result.status).toBe("already_connected");
    expect(writes()).toEqual([]);
  });

  it("a paid reconnect of a free-connected source starts indexing instead of answering already_connected", async () => {
    existingRow({ github_repository_id: 77, github_user_binding_id: 77, active: true, index_state: "ready", indexed: false });
    queryQueue.push([], [{ index_generation: 2 }], [], [], [], [], [{ id: "job-1" }]);
    const result = await connectSource(env, "user-1", "acme/notes");
    expect(result).toMatchObject({ status: "rebound", reindex_job_id: "job-1" });
    const sqlWrites = writes().join("\n");
    expect(sqlWrites).toMatch(/INSERT INTO knowledge\.github_team_reindex_subscriptions/);
    expect(sqlWrites).toContain("'reindexing'");
  });

  it("a paid repeat call on an indexed source stays a no-op", async () => {
    existingRow({ github_repository_id: 77, github_user_binding_id: 77, active: true, index_state: "ready", indexed: true });
    const result = await connectSource(env, "user-1", "acme/notes");
    expect(result.status).toBe("already_connected");
    expect(writes()).toEqual([]);
  });
});
