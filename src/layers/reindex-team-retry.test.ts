// Retry of the per-read team token (WP-5 Ф64, 09.11.2026): a transient broker refusal must not
// fail the file, while a binding that is no longer active must not be retried.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./team-github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./team-github.js")>();
  return { ...actual, repositoryToken: vi.fn(), activeTeamBinding: vi.fn() };
});

import { readLease, TEAM_TOKEN_RETRY_DELAYS_MS, type ReindexEnv } from "./reindex.js";
import { activeTeamBinding, repositoryToken, type TeamBinding } from "./team-github.js";
import type { UserContext } from "./personal.js";

const TEAM_SOURCE = "MimEcoSys/wp5-f64-index-race-test";
const ENV = {} as ReindexEnv;
const CTX = { userId: "user-1", sources: [] } as unknown as UserContext;
const BINDING: TeamBinding = { repositoryId: 7, installationId: 8, owner: "MimEcoSys", repository: "wp5-f64-index-race-test", generation: 1 };
const lease = (token: string) => ({ token, repositoryId: 7, release: async () => {} });
const totalDelay = TEAM_TOKEN_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);

describe("readLease", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    vi.mocked(repositoryToken).mockReset();
    vi.mocked(activeTeamBinding).mockReset().mockResolvedValue(BINDING);
  });
  afterEach(() => vi.useRealTimers());

  it("returns the token issued on a retry after a transient refusal", async () => {
    vi.mocked(repositoryToken).mockResolvedValueOnce(null).mockResolvedValueOnce(lease("second"));
    const pending = readLease(ENV, CTX, TEAM_SOURCE, "wp5-f64-index-race-test");
    await vi.advanceTimersByTimeAsync(totalDelay);
    expect((await pending)?.token).toBe("second");
    expect(repositoryToken).toHaveBeenCalledTimes(2);
  });

  it("retries after a thrown broker error (timeout) too", async () => {
    vi.mocked(repositoryToken).mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(lease("after-throw"));
    const pending = readLease(ENV, CTX, TEAM_SOURCE, "wp5-f64-index-race-test");
    await vi.advanceTimersByTimeAsync(totalDelay);
    expect((await pending)?.token).toBe("after-throw");
  });

  it("gives up after the last retry when every attempt is refused (revoked access stays revoked)", async () => {
    vi.mocked(repositoryToken).mockResolvedValue(null);
    const pending = readLease(ENV, CTX, TEAM_SOURCE, "wp5-f64-index-race-test");
    await vi.advanceTimersByTimeAsync(totalDelay);
    expect(await pending).toBeNull();
    expect(repositoryToken).toHaveBeenCalledTimes(TEAM_TOKEN_RETRY_DELAYS_MS.length + 1);
  });

  it("does not retry once the local binding is no longer active", async () => {
    vi.mocked(repositoryToken).mockResolvedValue(null);
    vi.mocked(activeTeamBinding).mockResolvedValue(null);
    expect(await readLease(ENV, CTX, TEAM_SOURCE, "wp5-f64-index-race-test")).toBeNull();
    expect(repositoryToken).toHaveBeenCalledOnce();
  });

  it("does not retry a personal source", async () => {
    vi.mocked(repositoryToken).mockResolvedValue(null);
    expect(await readLease(ENV, CTX, "DS-my-strategy", "DS-my-strategy")).toBeNull();
    expect(repositoryToken).toHaveBeenCalledOnce();
    expect(activeTeamBinding).not.toHaveBeenCalled();
  });
});
