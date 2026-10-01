import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchGitHubApi, githubApiHeaders } from "./github-api.js";

const TOKEN = "ghp_test_token_value_0123456789";
const TREE_URL = "https://api.github.com/repos/ailev/FPF/git/trees/main?recursive=1";

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Stubs global fetch with a queue of responses and records what each call sent. */
function stubFetch(responses: Response[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: input, headers: { ...(init?.headers ?? {}) } });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected extra fetch: ${input}`);
    return next;
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("githubApiHeaders", () => {
  it("sends only the user agent without a token", () => {
    expect(githubApiHeaders(undefined)).toEqual({ "User-Agent": "aisystant-knowledge-mcp" });
  });

  it("adds a bearer authorization with a token and keeps extra headers", () => {
    expect(githubApiHeaders(TOKEN, { Accept: "application/vnd.github.raw+json" })).toEqual({
      "User-Agent": "aisystant-knowledge-mcp",
      Accept: "application/vnd.github.raw+json",
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  it("treats an empty token like a missing one", () => {
    expect(githubApiHeaders("")).not.toHaveProperty("Authorization");
  });
});

describe("fetchGitHubApi", () => {
  it("stays anonymous when no token is configured", async () => {
    const calls = stubFetch([new Response("{}")]);
    const resp = await fetchGitHubApi(TREE_URL, undefined);
    expect(resp.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers).not.toHaveProperty("Authorization");
  });

  it("sends the token to api.github.com", async () => {
    const calls = stubFetch([new Response("{}")]);
    await fetchGitHubApi(TREE_URL, TOKEN);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("never sends the token to another host", async () => {
    const calls = stubFetch([new Response("text")]);
    await fetchGitHubApi("https://raw.githubusercontent.com/ailev/FPF/main/FPF-Spec.md", TOKEN);
    expect(calls[0].headers).not.toHaveProperty("Authorization");
  });

  it("passes extra headers through with the token", async () => {
    const calls = stubFetch([new Response("blob")]);
    await fetchGitHubApi("https://api.github.com/repos/ailev/FPF/git/blobs/abc", TOKEN, {
      Accept: "application/vnd.github.raw+json",
    });
    expect(calls[0].headers.Accept).toBe("application/vnd.github.raw+json");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("retries once anonymously when the token is rejected, and keeps the token out of the log", async () => {
    const calls = stubFetch([new Response("bad credentials", { status: 401 }), new Response("{}", { status: 200 })]);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const resp = await fetchGitHubApi(TREE_URL, TOKEN);

    expect(resp.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[1].headers).not.toHaveProperty("Authorization");
    expect(errorLog).toHaveBeenCalledTimes(1);
    const logged = String(errorLog.mock.calls[0][0]);
    expect(JSON.parse(logged)).toEqual({ phase: "github_token_rejected", host: "api.github.com" });
    expect(logged).not.toContain(TOKEN);
  });

  it("does not retry on 403, so the rate-limit classifier still sees the real response", async () => {
    const calls = stubFetch([new Response("rate limited", { status: 403, headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1790000000" } })]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const resp = await fetchGitHubApi(TREE_URL, TOKEN);
    expect(resp.status).toBe(403);
    expect(resp.headers.get("X-RateLimit-Reset")).toBe("1790000000");
    expect(calls).toHaveLength(1);
  });

  it("does not retry a 401 when there was no token to blame", async () => {
    const calls = stubFetch([new Response("unauthorized", { status: 401 })]);
    const resp = await fetchGitHubApi(TREE_URL, undefined);
    expect(resp.status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it("warns when the remaining quota is low, with the authenticated flag and no token", async () => {
    stubFetch([new Response("{}", { headers: { "X-RateLimit-Limit": "5000", "X-RateLimit-Remaining": "300" } })]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await fetchGitHubApi(TREE_URL, TOKEN);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0][0]);
    expect(JSON.parse(logged)).toEqual({ phase: "github_quota_low", authenticated: true, limit: 5000, remaining: 300 });
    expect(logged).not.toContain(TOKEN);
  });

  it("marks anonymous calls as unauthenticated in the low-quota warning", async () => {
    stubFetch([new Response("{}", { headers: { "X-RateLimit-Limit": "60", "X-RateLimit-Remaining": "2" } })]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await fetchGitHubApi(TREE_URL, undefined);
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({ authenticated: false, limit: 60, remaining: 2 });
  });

  it("stays quiet when plenty of quota remains or the headers are absent", async () => {
    stubFetch([
      new Response("{}", { headers: { "X-RateLimit-Limit": "5000", "X-RateLimit-Remaining": "4990" } }),
      new Response("{}"),
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await fetchGitHubApi(TREE_URL, TOKEN);
    await fetchGitHubApi(TREE_URL, TOKEN);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("api.github.com reads in index.ts", () => {
  it("all go through fetchGitHubApi, so a new call cannot fall back to the shared anonymous quota", () => {
    const lines = readFileSync(resolve(__dirname, "index.ts"), "utf8").split("\n");
    const bypasses = lines
      .map((text, i) => ({ line: i + 1, text: text.trim() }))
      .filter(({ text }) => text.includes("https://api.github.com") && !text.startsWith("//") && !text.startsWith("*"))
      .filter(({ text }) => !text.includes("fetchGitHubApi("));
    expect(bypasses).toEqual([]);
  });
});
