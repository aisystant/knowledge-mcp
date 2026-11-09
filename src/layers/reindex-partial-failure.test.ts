// A few failed files must not hide a fully rebuilt source, and a transient database-edge
// failure of a file write is repeated (WP-5 Ф64, 09.11.2026).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DB_WRITE_RETRY_DELAYS_MS, sourceStateAfterFullJob, withTransientDbRetry } from "./reindex.js";

describe("sourceStateAfterFullJob", () => {
  it("publishes a source with no errors", () => {
    expect(sourceStateAfterFullJob(0, 402)).toBe("ready");
  });

  it("publishes a source when some files failed but others were indexed", () => {
    expect(sourceStateAfterFullJob(3, 399)).toBe("ready");
  });

  it("keeps a source failed when nothing was indexed", () => {
    expect(sourceStateAfterFullJob(402, 0)).toBe("failed");
  });

  it("publishes an empty repository (no files, no errors)", () => {
    expect(sourceStateAfterFullJob(0, 0)).toBe("ready");
  });
});

describe("withTransientDbRetry", () => {
  const totalDelay = DB_WRITE_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
  const edgeError = () => new Error("Server error (HTTP status 520): error code: 520");

  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it("repeats a write that failed at the database edge", async () => {
    const write = vi.fn().mockRejectedValueOnce(edgeError()).mockResolvedValueOnce("written");
    const pending = withTransientDbRetry(write);
    await vi.advanceTimersByTimeAsync(totalDelay);
    expect(await pending).toBe("written");
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("gives up after the last retry and surfaces the error", async () => {
    const write = vi.fn().mockRejectedValue(edgeError());
    const pending = withTransientDbRetry(write);
    const outcome = expect(pending).rejects.toThrow("HTTP status 520");
    await vi.advanceTimersByTimeAsync(totalDelay);
    await outcome;
    expect(write).toHaveBeenCalledTimes(DB_WRITE_RETRY_DELAYS_MS.length + 1);
  });

  it("does not repeat a non-transient error (fence violation, bad query)", async () => {
    // A generation fence is SELECT 1/(...): a violation surfaces as Postgres "division by zero".
    const write = vi.fn().mockRejectedValue(new Error("division by zero"));
    await expect(withTransientDbRetry(write)).rejects.toThrow("division by zero");
    expect(write).toHaveBeenCalledOnce();
  });

  it("does not repeat a 4xx answer", async () => {
    const write = vi.fn().mockRejectedValue(new Error("Server error (HTTP status 401): unauthorized"));
    await expect(withTransientDbRetry(write)).rejects.toThrow("401");
    expect(write).toHaveBeenCalledOnce();
  });
});
