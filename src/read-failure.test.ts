import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchReadResponse, readHttpFailure, readJson, withReadDeadline } from "./read-failure.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

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
