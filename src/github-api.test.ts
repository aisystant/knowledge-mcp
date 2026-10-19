import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchGitHubApi, githubApiHeaders } from "./github-api.js";

const TOKEN = "ghp_test_token_value_0123456789";
const TREE_URL = "https://api.github.com/repos/ailev/FPF/git/trees/main?recursive=1";

interface Call {
  url: string;
  headers: Record<string, string>;
  redirect: string | undefined;
}

/** Stubs global fetch with a queue of responses and records what each call sent. */
function stubFetch(responses: Response[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: { headers?: Record<string, string>; redirect?: string }) => {
    calls.push({ url: input, headers: { ...(init?.headers ?? {}) }, redirect: init?.redirect });
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

  it.each(["Authorization", "authorization", "COOKIE", "Proxy-Authorization"])("drops a caller-supplied %s header", (name) => {
    const headers = githubApiHeaders(undefined, { [name]: "secret-value", Accept: "application/json" });
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain(name.toLowerCase());
    expect(headers.Accept).toBe("application/json");
  });

  it("lets only the token argument set Authorization, even if the caller passed another one", () => {
    expect(githubApiHeaders(TOKEN, { authorization: "Bearer other" }).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(Object.keys(githubApiHeaders(TOKEN, { authorization: "Bearer other" })).filter((k) => k.toLowerCase() === "authorization")).toHaveLength(1);
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

  it("takes over redirects itself only while a token is attached", async () => {
    const withToken = stubFetch([new Response("{}")]);
    await fetchGitHubApi(TREE_URL, TOKEN);
    expect(withToken[0].redirect).toBe("manual");

    vi.unstubAllGlobals();
    const anonymous = stubFetch([new Response("{}")]);
    await fetchGitHubApi(TREE_URL, undefined);
    expect(anonymous[0].redirect).toBeUndefined();
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

  it("never resends a rejected token on the anonymous retry, even if the caller passed it as an extra header", async () => {
    const calls = stubFetch([new Response("bad credentials", { status: 401 }), new Response("{}")]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await fetchGitHubApi(TREE_URL, TOKEN, { Authorization: `Bearer ${TOKEN}` });
    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[1].headers).map((k) => k.toLowerCase())).not.toContain("authorization");
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

describe("fetchGitHubApi and redirects", () => {
  const redirect = (location: string, status = 301) => new Response(null, { status, headers: { Location: location } });

  it("follows a same-host redirect by hand and sends the token on both hops", async () => {
    const calls = stubFetch([
      redirect("https://api.github.com/repositories/42/git/trees/main?recursive=1"),
      new Response("{}", { status: 200 }),
    ]);
    const resp = await fetchGitHubApi(TREE_URL, TOKEN);
    expect(resp.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([TREE_URL, "https://api.github.com/repositories/42/git/trees/main?recursive=1"]);
    expect(calls.map((c) => c.headers.Authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  });

  it.each([301, 302, 303, 307, 308])("follows a same-host %i redirect with the token", async (status) => {
    const calls = stubFetch([redirect("https://api.github.com/repositories/42/git/trees/main", status), new Response("{}")]);
    const resp = await fetchGitHubApi(TREE_URL, TOKEN);
    expect(resp.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("resolves a relative Location against the API host", async () => {
    const calls = stubFetch([redirect("/repositories/42/git/trees/main"), new Response("{}")]);
    const resp = await fetchGitHubApi(TREE_URL, TOKEN);
    expect(resp.status).toBe(200);
    expect(calls[1].url).toBe("https://api.github.com/repositories/42/git/trees/main");
    expect(calls[1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("does not follow a redirect to another host: the caller gets the 3xx and no second request is made", async () => {
    const calls = stubFetch([redirect("https://evil.example/steal", 302)]);
    const resp = await fetchGitHubApi(TREE_URL, TOKEN);
    expect(resp.status).toBe(302);
    expect(calls).toHaveLength(1);
  });

  it("does not follow a redirect to a look-alike host", async () => {
    const calls = stubFetch([redirect("https://api.github.com.evil.example/x", 307)]);
    const resp = await fetchGitHubApi(TREE_URL, TOKEN);
    expect(resp.status).toBe(307);
    expect(calls).toHaveLength(1);
  });

  it("does not follow a redirect that downgrades to http", async () => {
    const calls = stubFetch([redirect("http://api.github.com/x", 302)]);
    const resp = await fetchGitHubApi(TREE_URL, TOKEN);
    expect(resp.status).toBe(302);
    expect(calls).toHaveLength(1);
  });

  it("returns a redirect without a usable Location as it is", async () => {
    const calls = stubFetch([new Response(null, { status: 302 })]);
    const resp = await fetchGitHubApi(TREE_URL, TOKEN);
    expect(resp.status).toBe(302);
    expect(calls).toHaveLength(1);
  });

  it("gives up after too many same-host redirects", async () => {
    stubFetch(Array.from({ length: 5 }, () => redirect("https://api.github.com/loop")));
    await expect(fetchGitHubApi(TREE_URL, TOKEN)).rejects.toThrow("redirect limit");
  });

  it.each([
    ["a look-alike host", "https://api.github.com.evil.example/repos/x"],
    ["userinfo before another host", "https://api.github.com@evil.example/repos/x"],
    ["plain http", "http://api.github.com/repos/x"],
  ])("sends no token to %s", async (_label, url) => {
    const calls = stubFetch([new Response("{}")]);
    await fetchGitHubApi(url, TOKEN);
    expect(calls[0].headers).not.toHaveProperty("Authorization");
  });
});
