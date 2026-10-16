import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rows: [] as unknown[][], releases: 0 }));

vi.mock("@neondatabase/serverless", () => ({
  neon: () => Object.assign(
    async () => state.rows.shift() ?? [],
    { unsafe: (name: string) => name },
  ),
}));
vi.mock("./team-github.js", async importOriginal => ({
  ...await importOriginal<typeof import("./team-github.js")>(),
  repositoryToken: async () => ({ token: "scoped-user-token", release: async () => { state.releases++; } }),
}));

import { personalSearchDocuments, type UserContext } from "./personal.js";

const context: UserContext = {
  userId: "user-1", sourceNames: ["Org/editorial"],
  sources: [{ source: "Org/editorial", githubOwner: "Org", githubRepo: "editorial",
    pathPrefix: "", sourceType: "ds" }],
};

describe("team indexed search authorization", () => {
  beforeEach(() => {
    state.rows = [];
    state.releases = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["same fragment in a changed file", "secret with different remainder", 0],
    ["exact current file", "secret and approved remainder", 1],
  ])("checks %s before releasing indexed bytes", async (_scenario, current, expected) => {
    state.rows = [
      [{ filename: "doc.md", content: "secret", source: "Org/editorial", source_type: "ds", score: 1 }],
      [{ content: "secret and approved remainder" }],
    ];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer scoped-user-token" });
      return new Response(JSON.stringify({ sha: "a".repeat(40), content: btoa(current), encoding: "base64" }),
        { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const results = await personalSearchDocuments({ DATABASE_URL: "postgres://fixture" }, context,
      "DP.ROLE.040", "Org/editorial", 5);
    expect(results).toHaveLength(expected);
    expect(state.releases).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns no indexed bytes when the live GitHub read loses access", async () => {
    state.rows = [
      [{ filename: "doc.md", content: "secret", source: "Org/editorial", source_type: "ds", score: 1 }],
      [{ content: "secret and approved remainder" }],
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    const results = await personalSearchDocuments({ DATABASE_URL: "postgres://fixture" }, context,
      "DP.ROLE.040", "Org/editorial", 5);
    expect(results).toEqual([]);
    expect(state.releases).toBe(1);
  });
});
