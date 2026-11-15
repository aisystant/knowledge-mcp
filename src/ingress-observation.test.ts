// WP-560 Ф19 stage 1: every HTTP request leaves one "knowledge_ingress" line built from
// closed lists only. The HTTP-level tests go through the worker entry point and check both
// the classes and that no raw header value, token or id reaches the log.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { neon } from "@neondatabase/serverless";

vi.mock("@neondatabase/serverless", () => ({ neon: vi.fn(), neonConfig: {}, Pool: vi.fn() }));

vi.mock("./rls.js", () => ({
  createRequestPool: vi.fn(() => ({ end: vi.fn().mockResolvedValue(undefined) })),
  withUserContext: vi.fn(async (_dsn: string, _userId: unknown, fn: (sql: unknown) => Promise<unknown>) =>
    fn(Object.assign(() => Promise.resolve([{ cnt: 0 }]), { unsafe: (value: string) => value }))),
}));

vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  verifyJwtLocally: vi.fn(async (_oryUrl: string, token: string) => (token === "good-token-value" ? "jwt-subject-id" : null)),
}));

import worker, { SERVICE_AUTH_HEADER, WITHDRAWN_TOOL_MESSAGES } from "./index.js";
import type { Env } from "./index.js";
import { buildIngressEvent, classifyOrigin, classifyUserAgent, PARSE_FAILED } from "./ingress-observation.js";

const ENV = {
  MCP_MODE: "public",
  ORY_URL: "https://ory.test",
  KNOWLEDGE_DATABASE_URL: "mock-knowledge-dsn",
  HEALTH_DATABASE_URL: "mock-health-dsn",
} as unknown as Env;

let logged: string[] = [];
function ingressEvents(): Array<Record<string, unknown>> {
  return logged
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === "knowledge_ingress");
}

beforeEach(() => {
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.mocked(neon).mockReturnValue(Object.assign(() => Promise.resolve([]), { unsafe: (value: string) => value }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(neon).mockReset();
});

describe("classifyUserAgent", () => {
  it.each([
    [null, "none"],
    ["Claude-User", "claude"],
    ["openai-mcp", "openai"],
    ["n8n", "n8n"],
    ["python-httpx/0.27.0", "python"],
    ["aiohttp/3.9", "python"],
    ["node-fetch", "node"],
    ["curl/8.5.0", "curl"],
    ["Go-http-client/1.1", "go"],
    ["Mozilla/5.0 (X11; Linux x86_64)", "browser"],
    ["gateway-mcp-tool-day/1", "gateway"],
    ["some-private-tool/9 contact@example.org", "other"],
  ])("%j -> %s", (value, expected) => {
    expect(classifyUserAgent(value)).toBe(expected);
  });
});

describe("classifyOrigin", () => {
  it.each([
    [null, "none"],
    ["https://iwe.system-school.ru", "iwe.system-school.ru"],
    ["https://claude.ai", "claude.ai"],
    ["https://someone.example", "other"],
    ["not a url", "other"],
  ])("%j -> %s", (value, expected) => {
    expect(classifyOrigin(value)).toBe(expected);
  });
});

describe("buildIngressEvent", () => {
  const options = { isKnownTool: (name: string) => name === "search", serviceHeaderName: SERVICE_AUTH_HEADER };

  it("marks internet traffic by the edge header and service-binding traffic as internal", () => {
    const edge = new Request("https://k.test/health", { headers: { "cf-connecting-ip": "203.0.113.7" } });
    const internal = new Request("https://k.test/health");
    expect(buildIngressEvent(edge, "public", options).entry).toBe("edge");
    expect(buildIngressEvent(internal, "public", options).entry).toBe("internal");
  });

  it("collapses unknown paths, RPC methods and tools to other", () => {
    const event = buildIngressEvent(new Request("https://k.test/secret-admin"), "private", {
      ...options, body: { method: "sampling/createMessage", params: { name: "search" } },
    });
    expect(event).toMatchObject({ path: "other", mode: "private", rpc_method: "other", tool: null });
    const unknownTool = buildIngressEvent(new Request("https://k.test/mcp"), "public", {
      ...options, body: { method: "tools/call", params: { name: "drop_everything" } },
    });
    expect(unknownTool).toMatchObject({ rpc_method: "tools/call", tool: "other" });
  });

  it.each<[string, unknown, string | null, string | null]>([
    ["no body read", undefined, null, null],
    ["a batch", [{ method: "tools/call" }], "batch", null],
    ["null", null, "invalid", null],
    ["a string", "x", "invalid", null],
    ["unparseable JSON", PARSE_FAILED, "invalid", null],
    ["an object without method", { id: 1 }, "invalid", null],
    ["tools/call with params null", { method: "tools/call", params: null }, "tools/call", "other"],
  ])("body shape: %s", (_title, body, rpcMethod, tool) => {
    const opts = body === undefined ? options : { ...options, body };
    expect(buildIngressEvent(new Request("https://k.test/mcp"), "public", opts)).toMatchObject({ rpc_method: rpcMethod, tool });
  });

  it("a Bearer is bearer_unchecked unless a JWT check actually ran", () => {
    const request = new Request("https://k.test/reindex", { headers: { Authorization: "Bearer shared-secret" } });
    expect(buildIngressEvent(request, "public", options).auth).toBe("bearer_unchecked");
    expect(buildIngressEvent(request, "public", { ...options, jwtChecked: true }).auth).toBe("bearer_unverified");
  });

  it("gateway_marker reflects only the presence of X-Request-Id", () => {
    const marked = new Request("https://k.test/mcp", { headers: { "X-Request-Id": "req-value-123" } });
    const event = buildIngressEvent(marked, "public", options);
    expect(event.gateway_marker).toBe(true);
    expect(JSON.stringify(event)).not.toContain("req-value-123");
    expect(buildIngressEvent(new Request("https://k.test/mcp"), "public", options).gateway_marker).toBe(false);
  });
});

describe("worker entry point logs one knowledge_ingress line per request", () => {
  it("a direct /mcp tools/call from the internet: classes only, no raw values", async () => {
    const request = new Request("https://knowledge.test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-connecting-ip": "198.51.100.23",
        "User-Agent": "python-httpx/0.27.0 private-marker-ua",
        "x-user-id": "spoofed-user-id-value",
        Origin: "https://someone.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { query: "secret query text" } } }),
    });
    await worker.fetch(request, ENV);

    const events = ingressEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      event: "knowledge_ingress",
      mode: "public",
      path: "/mcp",
      http_method: "POST",
      entry: "edge",
      gateway_marker: false,
      auth: "x_user_id",
      service_header: false,
      user_agent: "python",
      origin: "other",
      rpc_method: "tools/call",
      tool: "search",
    });
    const line = JSON.stringify(events[0]);
    for (const raw of ["198.51.100.23", "private-marker-ua", "spoofed-user-id-value", "someone.example", "secret query text"]) {
      expect(line).not.toContain(raw);
    }
  });

  it("a verified token and the service header are recorded as kinds, not values", async () => {
    const request = new Request("https://knowledge.test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer good-token-value",
        [SERVICE_AUTH_HEADER]: "service-secret-value",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    await worker.fetch(request, ENV);

    expect(ingressEvents()).toHaveLength(1);
    const [event] = ingressEvents();
    expect(event).toMatchObject({ entry: "internal", auth: "jwt_verified", service_header: true, rpc_method: "tools/list", tool: null });
    const line = JSON.stringify(event);
    for (const raw of ["good-token-value", "jwt-subject-id", "service-secret-value"]) {
      expect(line).not.toContain(raw);
    }
  });

  it("an unverifiable bearer is bearer_unverified", async () => {
    const request = new Request("https://knowledge.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer forged-token-value" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    });
    await worker.fetch(request, ENV);
    expect(ingressEvents()).toHaveLength(1);
    expect(ingressEvents()[0]).toMatchObject({ auth: "bearer_unverified" });
    expect(JSON.stringify(ingressEvents()[0])).not.toContain("forged-token-value");
  });

  it("non-/mcp routes are logged on entry, including CORS preflight", async () => {
    await worker.fetch(new Request("https://knowledge.test/", { method: "OPTIONS", headers: { Origin: "https://iwe.system-school.ru" } }), ENV);
    await worker.fetch(new Request("https://knowledge.test/reindex", { method: "POST", headers: { Authorization: "Bearer wrong-secret-value" } }), ENV);

    const events = ingressEvents();
    expect(events.map(event => [event.path, event.http_method, event.origin, event.auth])).toEqual([
      ["/", "OPTIONS", "iwe.system-school.ru", "none"],
      ["/reindex", "POST", "none", "bearer_unchecked"],
    ]);
    expect(JSON.stringify(events)).not.toContain("wrong-secret-value");
  });

  it("private mode names a private tool", async () => {
    const request = new Request("https://knowledge.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-Id": "gw-req-1" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "write", arguments: {} } }),
    });
    await worker.fetch(request, { ...ENV, MCP_MODE: "private" } as unknown as Env);
    expect(ingressEvents()).toHaveLength(1);
    expect(ingressEvents()[0]).toMatchObject({ mode: "private", tool: "write", gateway_marker: true, auth: "none" });
  });

  it("a withdrawn tool name is named, not collapsed", async () => {
    const [withdrawn] = [...WITHDRAWN_TOOL_MESSAGES.keys()];
    const request = new Request("https://knowledge.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: withdrawn } }),
    });
    await worker.fetch(request, ENV);
    expect(ingressEvents()[0]).toMatchObject({ tool: withdrawn });
  });

  it.each<[string, string]>([
    ["a batch", JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }])],
    ["null", "null"],
    ["a string", JSON.stringify("x")],
    ["params null", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: null })],
  ])("odd body (%s) still gives exactly one line", async (_title, body) => {
    const request = new Request("https://knowledge.test/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    await worker.fetch(request, ENV).catch(() => undefined);
    expect(ingressEvents()).toHaveLength(1);
  });

  it("malformed JSON is logged as invalid and the error still propagates", async () => {
    const request = new Request("https://knowledge.test/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
    await expect(worker.fetch(request, ENV)).rejects.toThrow();
    expect(ingressEvents()).toHaveLength(1);
    expect(ingressEvents()[0]).toMatchObject({ path: "/mcp", rpc_method: "invalid", tool: null });
  });

  it("a throwing token check still leaves one line and the error propagates", async () => {
    const { verifyJwtLocally } = await import("./auth.js");
    vi.mocked(verifyJwtLocally).mockRejectedValueOnce(new Error("jwks unreachable"));
    const request = new Request("https://knowledge.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer any-token-value" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list" }),
    });
    await expect(worker.fetch(request, ENV)).rejects.toThrow("jwks unreachable");
    expect(ingressEvents()).toHaveLength(1);
    expect(ingressEvents()[0]).toMatchObject({ auth: "bearer_unverified", rpc_method: null });
    expect(JSON.stringify(ingressEvents()[0])).not.toContain("any-token-value");
  });
});
