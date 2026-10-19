// WP-7 Ф190, step 1: the worker tells three kinds of callers of learner_progress and
// analyze_verbalization apart (verified JWT, verified platform service credential, neither),
// records which one called (no ids, no secrets) and, only in enforce mode, refuses "neither".
// Everything goes through the worker's HTTP entry point, like the identity tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { neon } from "@neondatabase/serverless";

vi.mock("@neondatabase/serverless", () => ({ neon: vi.fn(), neonConfig: {}, Pool: vi.fn() }));

const userContexts: Array<string | null | undefined> = [];
vi.mock("./rls.js", () => ({
  createRequestPool: vi.fn(() => ({ end: vi.fn().mockResolvedValue(undefined) })),
  withUserContext: vi.fn(async (_dsn: string, userId: string | null | undefined, fn: (sql: unknown) => Promise<unknown>) => {
    userContexts.push(userId);
    return fn(Object.assign(() => Promise.resolve([{ cnt: 0 }]), { unsafe: (value: string) => value }));
  }),
}));

vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  verifyJwtLocally: vi.fn(async (_oryUrl: string, token: string) => (token === "good" ? "jwt-subject" : null)),
}));

import worker, { classifyLearnerCaller, SERVICE_AUTH_HEADER } from "./index.js";
import type { Env } from "./index.js";

const GATEWAY_SECRET = "gateway-secret-value";
const N8N_SECRET = "n8n-secret-value";
const BASE_ENV = {
  MCP_MODE: "public",
  ORY_URL: "https://ory.test",
  KNOWLEDGE_DATABASE_URL: "mock-knowledge-dsn",
  HEALTH_DATABASE_URL: "mock-health-dsn",
  LEARNER_TOOLS_SERVICE_SECRETS: `gateway:${GATEWAY_SECRET}, n8n:${N8N_SECRET}`,
} as unknown as Env;
const ENFORCE_ENV = { ...BASE_ENV, LEARNER_TOOLS_SERVICE_AUTH: "enforce" } as unknown as Env;

interface Caller {
  bearer?: string;
  serviceHeader?: string;
}

function requestFor(name: string, who: Caller): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (who.bearer) headers.Authorization = `Bearer ${who.bearer}`;
  if (who.serviceHeader) headers[SERVICE_AUTH_HEADER] = who.serviceHeader;
  return new Request("https://knowledge.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { user_id: "argument-user", text: "t" } } }),
  });
}

async function call(name: string, who: Caller, env: Env = BASE_ENV) {
  const res = await worker.fetch(requestFor(name, who), env);
  return (await res.json()) as { error?: { code: number; message: string } };
}

let logged: string[] = [];
function callerEvents(): Array<Record<string, unknown>> {
  return logged
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .filter((entry) => entry.event === "learner_tool_caller");
}

beforeEach(() => {
  userContexts.length = 0;
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
  // Every statement finds no concepts, so analyze_verbalization ends early without a write.
  vi.mocked(neon).mockReturnValue(Object.assign(() => Promise.resolve([]), { unsafe: (value: string) => value }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(neon).mockReset();
});

describe("classifyLearnerCaller", () => {
  const withHeader = (value: string) => new Request("https://x.test", { headers: { [SERVICE_AUTH_HEADER]: value } });

  it.each([
    ["a verified subject", "sub", undefined, { kind: "jwt" }],
    ["a blank but verified subject is still a JWT caller", "", undefined, { kind: "jwt" }],
    ["the gateway credential", undefined, withHeader(GATEWAY_SECRET), { kind: "service", name: "gateway" }],
    ["the n8n credential (spaces around the pair are ignored)", undefined, withHeader(N8N_SECRET), { kind: "service", name: "n8n" }],
    ["a wrong credential", undefined, withHeader("wrong"), { kind: "unauthenticated" }],
    ["a credential that is only a prefix of a real one", undefined, withHeader(GATEWAY_SECRET.slice(0, -1)), { kind: "unauthenticated" }],
    ["no header", undefined, new Request("https://x.test"), { kind: "unauthenticated" }],
    ["no request at all", undefined, undefined, { kind: "unauthenticated" }],
  ])("%s", (_title, subject, request, expected) => {
    expect(classifyLearnerCaller(BASE_ENV, subject, request)).toEqual(expected);
  });

  it("the JWT wins when both are present", () => {
    expect(classifyLearnerCaller(BASE_ENV, "sub", withHeader(GATEWAY_SECRET))).toEqual({ kind: "jwt" });
  });

  it.each([undefined, "", "gateway", ":secret-without-name", "gateway:"])("ignores an unusable secret list %j", (secrets) => {
    const env = { ...BASE_ENV, LEARNER_TOOLS_SERVICE_SECRETS: secrets } as unknown as Env;
    expect(classifyLearnerCaller(env, undefined, withHeader(GATEWAY_SECRET))).toEqual({ kind: "unauthenticated" });
  });
});

describe.each(["learner_progress", "analyze_verbalization"])("%s: observation mode (default)", (tool) => {
  it.each<[string, Caller, Record<string, unknown>]>([
    ["a verified JWT", { bearer: "good" }, { caller: "jwt" }],
    ["the gateway credential", { serviceHeader: GATEWAY_SECRET }, { caller: "service", service: "gateway" }],
    ["the n8n credential", { serviceHeader: N8N_SECRET }, { caller: "service", service: "n8n" }],
    ["nothing", {}, { caller: "unauthenticated" }],
    ["a forged bearer and a wrong credential", { bearer: "forged", serviceHeader: "wrong" }, { caller: "unauthenticated" }],
  ])("records %s and lets the call through", async (_title, who, expected) => {
    const body = await call(tool, who);
    expect(body.error).toBeUndefined();
    expect(callerEvents()).toEqual([expect.objectContaining({ tool, argument_id_present: true, mode: "off", ...expected })]);
  });

  it("never writes a secret or an id into the log", async () => {
    await call(tool, { serviceHeader: GATEWAY_SECRET });
    const text = logged.join("\n");
    expect(text).not.toContain(GATEWAY_SECRET);
    expect(text).not.toContain(N8N_SECRET);
    expect(text).not.toContain("argument-user");
  });
});

describe.each(["learner_progress", "analyze_verbalization"])("%s: enforce mode", (tool) => {
  it.each<[string, Caller]>([
    ["nothing", {}],
    ["a forged bearer", { bearer: "forged" }],
    ["a wrong credential", { serviceHeader: "wrong" }],
  ])("refuses %s before touching the database", async (_title, who) => {
    const body = await call(tool, who, ENFORCE_ENV);
    expect(body.error).toEqual({ code: -32001, message: expect.stringContaining("requires a verified user token or a platform service credential") });
    expect(userContexts).toEqual([]);
    expect(callerEvents()).toEqual([expect.objectContaining({ tool, caller: "unauthenticated", mode: "enforce" })]);
  });

  it.each<[string, Caller]>([
    ["a verified JWT", { bearer: "good" }],
    ["the gateway credential", { serviceHeader: GATEWAY_SECRET }],
    ["the n8n credential", { serviceHeader: N8N_SECRET }],
  ])("lets %s through", async (_title, who) => {
    const body = await call(tool, who, ENFORCE_ENV);
    expect(body.error).toBeUndefined();
  });

  it("does not treat any other value of the mode variable as enforce", async () => {
    const env = { ...BASE_ENV, LEARNER_TOOLS_SERVICE_AUTH: "ENFORCE " } as unknown as Env;
    expect((await call(tool, {}, env)).error).toBeUndefined();
  });
});
