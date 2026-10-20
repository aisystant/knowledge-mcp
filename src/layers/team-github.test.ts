import { describe, expect, it, vi } from "vitest";
import { enumerateTeamMarkdownFiles, repositoryToken, teamMarkdownFiles, teamRepositoryName, teamReposEnabled } from "./team-github.js";
import type { UserContext } from "./personal.js";

const context: UserContext = {
  userId: "user-1",
  sourceNames: ["MimEcoSys/editorial-lpf"],
  sources: [{ source: "MimEcoSys/editorial-lpf", githubOwner: "MimEcoSys",
    githubRepo: "editorial-lpf", pathPrefix: "", sourceType: "ds" }],
};

describe("team repository authorization boundary", () => {
  it("never falls back to the shared App token for an organization source", async () => {
    const legacy = vi.fn(async () => "installation-token");
    expect(await repositoryToken({}, context, "MimEcoSys/editorial-lpf", "write", legacy)).toBeNull();
    expect(await repositoryToken({}, context, "MimEcoSys/../editorial-lpf", "read", legacy)).toBeNull();
    expect(legacy).not.toHaveBeenCalled();
    expect(teamReposEnabled({ GITHUB_TEAM_REPOS_ENABLED: "false" })).toBe(false);
    expect(teamReposEnabled({ GITHUB_TEAM_REPOS_ENABLED: "true" })).toBe(true);
  });

  it("retains the existing personal source token path", async () => {
    const legacy = vi.fn(async () => "installation-token");
    const lease = await repositoryToken({}, context, "DS-my-strategy", "read", legacy);
    expect(lease?.token).toBe("installation-token");
    expect(legacy).toHaveBeenCalledOnce();
    await lease?.release();
  });

  it("does not enumerate a source absent from the authenticated user's context", async () => {
    expect(teamRepositoryName("MimEcoSys/editorial-lpf")).toEqual({ owner: "MimEcoSys", repository: "editorial-lpf" });
    expect(await teamMarkdownFiles({}, context, "Other/private-repo")).toEqual([]);
  });
});

describe("team repository Markdown listing", () => {
  const source = "MimEcoSys/editorial-lpf";
  const metadata = { id: 42, full_name: source, default_branch: "main", size: 0 };

  it("recognizes a truly empty repository whose advertised default branch does not exist", async () => {
    const githubFetch = vi.fn()
      .mockResolvedValueOnce(Response.json(metadata))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json([]));

    expect(await enumerateTeamMarkdownFiles(source, 42, "user-token", githubFetch)).toEqual([]);
    expect(githubFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/repos/MimEcoSys/editorial-lpf",
      "https://api.github.com/repos/MimEcoSys/editorial-lpf/branches/main",
      "https://api.github.com/repos/MimEcoSys/editorial-lpf/branches?per_page=1",
    ]);
  });

  it("lists the first Markdown file even while GitHub still reports size zero", async () => {
    const githubFetch = vi.fn()
      .mockResolvedValueOnce(Response.json(metadata))
      .mockResolvedValueOnce(Response.json({ commit: { sha: "commit-sha" } }))
      .mockResolvedValueOnce(Response.json({ tree: [
        { path: "README.md", type: "blob", size: 176 },
        { path: "image.png", type: "blob", size: 20 },
      ], truncated: false }));

    expect(await enumerateTeamMarkdownFiles(source, 42, "user-token", githubFetch)).toEqual([
      { path: "README.md", size: 176 },
    ]);
    expect(githubFetch.mock.calls[0][1]).toMatchObject({
      redirect: "manual",
      headers: { Authorization: "Bearer user-token", "User-Agent": "aisystant-knowledge" },
    });
  });

  it("does not mistake a missing default branch for an empty repository when other branches exist", async () => {
    const githubFetch = vi.fn()
      .mockResolvedValueOnce(Response.json(metadata))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json([{ name: "other" }]));

    await expect(enumerateTeamMarkdownFiles(source, 42, "user-token", githubFetch))
      .rejects.toThrow("GitHub branch unavailable");
  });

  it("reports only the stage and HTTP status on a GitHub failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const githubFetch = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    try {
      await expect(enumerateTeamMarkdownFiles(source, 42, "user-token", githubFetch))
        .rejects.toThrow("GitHub repository listing unavailable");
      expect(warn).toHaveBeenCalledWith(JSON.stringify({
        event: "team_repository_listing_http_error", stage: "metadata", status: 403,
      }));
    } finally {
      warn.mockRestore();
    }
  });
});
