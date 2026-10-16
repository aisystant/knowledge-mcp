import { describe, expect, it, vi } from "vitest";
import { repositoryToken, teamMarkdownFiles, teamRepositoryName, teamReposEnabled } from "./team-github.js";
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
