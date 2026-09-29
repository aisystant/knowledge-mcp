// WP-7 Ф187: learner_progress and analyze_verbalization take the learner id from their
// arguments and key row-level security by it. A verified JWT subject must always win over
// the argument; without a JWT the argument keeps working (hw-checker sends it directly
// and carries no token). Every case goes through the worker's HTTP entry point so the
// identity wiring in the /mcp handler is exercised, not only the helper.
import { beforeEach, describe, expect, it, vi } from "vitest";
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

import worker, { resolveLearnerId } from "./index.js";
import type { Env } from "./index.js";

const ENV = {
  MCP_MODE: "public",
  ORY_URL: "https://ory.test",
  KNOWLEDGE_DATABASE_URL: "mock-knowledge-dsn",
  HEALTH_DATABASE_URL: "mock-health-dsn",
} as unknown as Env;

interface CallerHeaders {
  bearer?: string;
  headerUserId?: string;
}

async function callTool(name: string, args: Record<string, unknown>, who: CallerHeaders): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (who.bearer) headers.Authorization = `Bearer ${who.bearer}`;
  if (who.headerUserId) headers["x-user-id"] = who.headerUserId;
  const res = await worker.fetch(
    new Request("https://knowledge.test/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    ENV,
  );
  return { status: res.status, body: await res.json() };
}

// A stand-in for the concept-graph database that lets analyze_verbalization reach its
// mastery write: one concept whose name occurs in the text, no edges, no misconceptions.
// Every INSERT it receives is recorded together with its bound values.
function stubConceptGraphDatabase(): Array<{ values: unknown[] }> {
  const inserts: Array<{ values: unknown[] }> = [];
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("INSERT INTO")) {
        inserts.push({ values });
        return Promise.resolve([]);
      }
      if (text.includes("SELECT id, code, name")) {
        return Promise.resolve([{ id: 1, code: "C1", name: "модель", definition: "d", level: "pack", domain: "d", similarity: 1 }]);
      }
      if (text.includes("COUNT")) return Promise.resolve([{ cnt: 0 }]);
      return Promise.resolve([]);
    },
    { unsafe: (value: string) => value },
  );
  vi.mocked(neon).mockReturnValue(sql as never);
  // The LLM judge is unavailable, so the handler falls back to plain name matching.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
  return inserts;
}

beforeEach(() => {
  userContexts.length = 0;
  vi.mocked(neon).mockReset();
  vi.unstubAllGlobals();
});

describe("resolveLearnerId", () => {
  it.each([
    ["a verified subject beats the argument", "A", { user_id: "B" }, "A"],
    ["without a subject the argument is used", undefined, { user_id: "B" }, "B"],
    ["an empty argument is no id", undefined, { user_id: "" }, undefined],
    ["a non-string argument is no id", undefined, { user_id: 7 }, undefined],
    ["nothing at all", undefined, {}, undefined],
  ])("%s", (_title, subject, args, expected) => {
    expect(resolveLearnerId(subject, args)).toBe(expected);
  });
});

describe("learner_progress through the HTTP entry point", () => {
  it.each<[string, CallerHeaders, string | undefined]>([
    ["JWT subject beats the argument", { bearer: "good" }, "jwt-subject"],
    ["JWT subject beats both the header and the argument", { bearer: "good", headerUserId: "header-user" }, "jwt-subject"],
    ["without a JWT the header does not act as the learner id", { headerUserId: "header-user" }, "argument-user"],
    ["without any identity the argument is used (platform callers)", {}, "argument-user"],
  ])("%s", async (_title, who, expectedContext) => {
    const { body } = await callTool("learner_progress", { user_id: "argument-user" }, who);
    expect(body.error).toBeUndefined();
    expect(userContexts).toEqual([expectedContext]);
  });

  it("an invalid token does not turn the argument into a verified id but keeps the old behaviour", async () => {
    const { body } = await callTool("learner_progress", { user_id: "argument-user" }, { bearer: "forged" });
    expect(body.error).toBeUndefined();
    expect(userContexts).toEqual(["argument-user"]);
  });

  it("refuses when there is no id from any source, without touching the database", async () => {
    const { body } = await callTool("learner_progress", {}, {});
    expect(body.error).toEqual({ code: -32602, message: "user_id is required" });
    expect(userContexts).toEqual([]);
  });
});

describe("analyze_verbalization through the HTTP entry point", () => {
  const args = { text: "Ученик объясняет модель своими словами", user_id: "argument-user" };

  it("writes the mastery row for the verified subject, not for the argument", async () => {
    const inserts = stubConceptGraphDatabase();
    const { body } = await callTool("analyze_verbalization", args, { bearer: "good" });
    expect(body.error).toBeUndefined();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toContain("jwt-subject");
    expect(inserts[0].values).not.toContain("argument-user");
  });

  it("without a JWT keeps writing for the id the platform caller sent", async () => {
    const inserts = stubConceptGraphDatabase();
    await callTool("analyze_verbalization", args, {});
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toContain("argument-user");
  });

  it("without any id writes nothing", async () => {
    const inserts = stubConceptGraphDatabase();
    await callTool("analyze_verbalization", { text: args.text }, {});
    expect(inserts).toHaveLength(0);
  });
});
