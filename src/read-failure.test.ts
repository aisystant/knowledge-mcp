import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadFailure, createReadTrace, fetchReadResponse, readHttpFailure, readJson, withReadDeadline } from "./read-failure.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("read-stage diagnostics", () => {
  it("shows the outstanding stage before a dependency finishes, preserving its result", async () => {
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    let complete!: (value: object) => void;
    const payload = { content: "PRIVATE-DOCUMENT", query: "PRIVATE-QUERY" };
    const trace = createReadTrace("personal_search");
    const pending = trace.run("keyword", () => new Promise<object>(resolve => { complete = resolve; }));
    expect(logs.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      expect.objectContaining({ event: "read_stage", operation: "personal_search", stage: "keyword", phase: "start" }),
    ]);
    complete(payload);
    expect(await pending).toBe(payload);
    const [start, end] = logs.mock.calls.map(([line]) => JSON.parse(line));
    expect(end).toMatchObject({ trace_id: start.trace_id, phase: "end", outcome: "success", elapsed_ms: expect.any(Number) });
    expect(end.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(logs.mock.calls)).not.toContain("PRIVATE-");
  });

  it("correlates stages internally without exposing exception details or altering the exception", async () => {
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    const failure = new Error("PRIVATE-TOKEN in PRIVATE-URL");
    const trace = createReadTrace("platform_search");
    await expect(trace.run("db_query", async () => { throw failure; })).rejects.toBe(failure);
    await trace.run("db_rollback", async () => undefined);
    await createReadTrace("platform_search").run("db_connect", async () => undefined);
    const events = logs.mock.calls.map(([line]) => JSON.parse(line));
    expect(events[1]).toMatchObject({ phase: "end", outcome: "error", error_kind: "unclassified" });
    expect(new Set(events.slice(0, 4).map(row => row.trace_id)).size).toBe(1);
    expect(events[4].trace_id).not.toBe(events[0].trace_id);
    expect(JSON.stringify(events)).not.toContain("PRIVATE-");
    const allowed = new Set(["event", "trace_id", "operation", "stage", "phase", "elapsed_ms", "outcome", "error_kind"]);
    expect(events.every(row => Object.keys(row).every(key => allowed.has(key)))).toBe(true);
  });

  it("logs only the fixed failure code of a typed read error", async () => {
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    const failure = new ReadFailure("dependency_timeout", "database");
    await expect(createReadTrace("memory_search").run("vector", async () => { throw failure; })).rejects.toBe(failure);
    expect(JSON.parse(logs.mock.calls[1][0])).toMatchObject({ error_kind: "dependency_timeout", outcome: "error" });
  });
});

describe("safe read diagnostics", () => {
  it.each([401, 403, 429, 503])("preserves status %i without provider response bodies", status => {
    const response = new Response("PRIVATE-UPSTREAM-BODY", { status, headers: { "x-github-request-id": "SAFE:123" } });
    const diagnostic = readHttpFailure(response, "github_content").toJSON();
    expect(diagnostic).toMatchObject({ status, stage: "github_content" });
    expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE-UPSTREAM-BODY");
    expect(diagnostic.retryable).toBe(status === 429 || status >= 500);
  });

  it("classifies a rate-limited GitHub 403 and honors its wait instruction", () => {
    const response = new Response("", { status: 403, headers: { "retry-after": "90", "x-github-request-id": "https://private.invalid?secret=value" } });
    const diagnostic = readHttpFailure(response, "github_token").toJSON();
    expect(diagnostic).toMatchObject({ error: "dependency_rate_limited", retry_after_seconds: 90, retryable: true });
    expect(diagnostic).not.toHaveProperty("request_id");
  });

  it("never reflects arbitrary diagnostic headers, even when they resemble identifiers", () => {
    const response = new Response("", { status: 503, headers: {
      "x-request-id": "sk-synthetic-secret",
      "x-github-request-id": "ghs_synthetic_secret",
    } });
    const diagnostic = readHttpFailure(response, "github_content").toJSON();
    expect(diagnostic).not.toHaveProperty("request_id");
    expect(JSON.stringify(diagnostic)).not.toContain("synthetic");
  });

  it("bounds stalled response bodies even if the body reader ignores cancellation", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return { ok: true, status: 200, json: () => new Promise(() => {}) };
    }));
    const pending = withReadDeadline("github_content", async abort => {
      const response = await fetchReadResponse("https://api.github.com/synthetic", {}, "github_content", abort);
      return readJson(response, "github_content");
    }, 50);
    const assertion = expect(pending).rejects.toMatchObject({ code: "dependency_timeout", stage: "github_content" });
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans its deadline after a successful complete response", async () => {
    vi.useFakeTimers();
    const result = await withReadDeadline("github_content", async () => ({ content: "complete" }), 50);
    expect(result).toEqual({ content: "complete" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replaces network exception details with a safe diagnostic", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("PRIVATE-TOKEN in failing URL")));
    let error: unknown;
    try {
      await withReadDeadline("github_content", signal => fetchReadResponse("https://api.github.com/synthetic", {}, "github_content", signal));
    } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "dependency_unavailable", stage: "github_content" });
    expect(String(error)).not.toContain("PRIVATE-TOKEN");
  });
});
