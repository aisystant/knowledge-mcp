/**
 * Paged export of concepts for platform services (WP-596 F67).
 * Runs through handleMcpRequest with a mocked database driver that records the SQL text.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMcpRequest, PLATFORM_DENY_SOURCES } from "./index.js";
import type { Env } from "./index.js";
import { NAME_EN_PUBLISHABLE_RULES_VERSION } from "./name-en-publishable.js";
import { buildConceptListPage, parseAfterId, parseLimit } from "./concept-list.js";

type Call = { text: string; values: unknown[] };

const { calls, state } = vi.hoisted(() => ({
  calls: [] as { text: string; values: unknown[] }[],
  state: { responder: (() => []) as (call: { text: string; values: unknown[] }) => unknown[] },
}));

function makeSql() {
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const call = { text: strings.join("?"), values };
    calls.push(call);
    return Promise.resolve(state.responder(call));
  }) as unknown as { (...args: unknown[]): Promise<unknown[]>; unsafe: (value: string) => string };
  sql.unsafe = (value: string) => value;
  return sql;
}

vi.mock("@neondatabase/serverless", () => ({
  neon: vi.fn(() => makeSql()),
  neonConfig: {},
  Pool: vi.fn(),
}));

vi.mock("./rls.js", () => ({
  createRequestPool: vi.fn(() => ({ end: vi.fn().mockResolvedValue(undefined) })),
  withUserContext: vi.fn(async (_dsn: string, _userId: unknown, fn: (sql: unknown) => Promise<unknown>) => fn(makeSql())),
}));

const SECRET = "exporter-secret-value";
const ENV = {
  KNOWLEDGE_DATABASE_URL: "postgres://example",
  LEARNER_TOOLS_SERVICE_SECRETS: `glossary-exporter:${SECRET}`,
} as Env;
const AS_OF = new Date("2026-11-01T20:00:00.000Z");

const asService = () => new Request("https://example.test/mcp", { headers: { "X-IWE-Service-Auth": SECRET } });
const asStranger = () => new Request("https://example.test/mcp", { headers: { "X-IWE-Service-Auth": "wrong" } });

function row(id: number, extra: Record<string, unknown> = {}) {
  return { id, code: `C.${id}`, name: `Понятие ${id}`, level: "pack", domain: "DP", status: "active", name_en: `Concept ${id}`, name_en_status: "ok", ...extra };
}

async function call(args: Record<string, unknown>, request?: Request, jwtSubject?: string) {
  return handleMcpRequest(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "concept_list", arguments: args } },
    ENV,
    undefined,
    "public",
    request,
    jwtSubject,
  );
}

function pageOf(response: Awaited<ReturnType<typeof call>>) {
  const result = response.result as { content: { text: string }[] };
  return JSON.parse(result.content[0]!.text) as { as_of: string; rows: Record<string, unknown>[]; next_after_id: number | null };
}

beforeEach(() => {
  calls.length = 0;
  state.responder = () => [];
});

describe("who may call concept_list", () => {
  it.each([
    ["no credential", undefined, undefined],
    ["a wrong service secret", asStranger(), undefined],
    ["a signed-in user without a service secret", undefined, "user-1"],
  ])("refuses %s and never reads the database", async (_name, request, jwtSubject) => {
    const response = await call({}, request, jwtSubject);
    expect(response.error?.message).toBe("concept_list requires a platform service credential");
    expect(calls).toHaveLength(0);
  });

  it("refuses even when service enforcement for learner tools is off", async () => {
    const response = await call({}, undefined);
    expect(response.error).toBeDefined();
  });

  it("serves a platform service", async () => {
    state.responder = (c) => (c.text.includes("NOW()") ? [{ as_of: AS_OF }] : [row(1)]);
    const response = await call({}, asService());
    expect(response.error).toBeUndefined();
    expect(pageOf(response).rows).toHaveLength(1);
  });
});

describe("the page", () => {
  it("returns the fields of the snapshot, the four English-name fields and a cursor", async () => {
    state.responder = (c) => (c.text.includes("NOW()") ? [{ as_of: AS_OF }] : [row(5), row(9, { name_en: null })]);
    const page = pageOf(await call({ limit: 10 }, asService()));
    expect(page.as_of).toBe("2026-11-01T20:00:00.000Z");
    expect(page.next_after_id).toBeNull();
    expect(page.rows).toEqual([
      { id: 5, code: "C.5", name: "Понятие 5", level: "pack", domain: "DP", status: "active",
        name_en: "Concept 5", name_en_status_raw: "ok", name_en_publishable: true, name_en_publishable_rules_version: NAME_EN_PUBLISHABLE_RULES_VERSION },
      { id: 9, code: "C.9", name: "Понятие 9", level: "pack", domain: "DP", status: "active",
        name_en: null, name_en_status_raw: "ok", name_en_publishable: false, name_en_publishable_rules_version: NAME_EN_PUBLISHABLE_RULES_VERSION },
    ]);
  });

  it("walks the whole graph with the cursor and ends with null", async () => {
    const all = [1, 2, 3, 4, 5].map((id) => row(id));
    state.responder = (c) => {
      if (c.text.includes("NOW()")) return [{ as_of: AS_OF }];
      const after = c.values[1] as number;
      const limitPlusOne = c.values[c.values.length - 1] as number;
      return all.filter((r) => r.id > after).slice(0, limitPlusOne);
    };
    const seen: number[] = [];
    let cursor = 0;
    let pages = 0;
    for (;;) {
      const page = pageOf(await call({ after_id: cursor, limit: 2 }, asService()));
      seen.push(...page.rows.map((r) => r.id as number));
      pages++;
      if (page.next_after_id === null) break;
      cursor = page.next_after_id;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(pages).toBe(3);
  });

  it("asks the database for limit + 1 rows from the cursor, in id order, active only", async () => {
    await call({ after_id: 40, limit: 3 }, asService());
    const select = calls.find((c) => c.text.includes("FROM") && c.text.includes("ORDER BY c.id"));
    expect(select?.text).toContain("c.status = 'active'");
    expect(select?.text).toContain("c.id > ?");
    expect(select?.values).toContain(40);
    expect(select?.values[select.values.length - 1]).toBe(4);
  });

  it("applies the closed-source deny-list in the query", async () => {
    await call({}, asService());
    const select = calls.find((c) => c.text.includes("ORDER BY c.id"));
    expect(select?.text).toContain("c.source_repo = ANY(?::text[])");
    expect(select?.values).toContainEqual([...PLATFORM_DENY_SOURCES]);
  });

  it("turns a bigint id from the driver into a number", () => {
    const page = buildConceptListPage([row(7, { id: "7" } as never)], 10, AS_OF);
    expect(page.rows[0]!.id).toBe(7);
  });
});

describe("arguments", () => {
  it.each([
    [{ limit: 0 }, "limit must be a positive integer"],
    [{ limit: 1.5 }, "limit must be a positive integer"],
    [{ limit: "10" }, "limit must be a positive integer"],
    [{ after_id: -1 }, "after_id must be a non-negative integer"],
    [{ after_id: "5" }, "after_id must be a non-negative integer"],
  ])("rejects %j", async (args, message) => {
    const response = await call(args, asService());
    expect(response.error?.message).toBe(message);
    expect(calls).toHaveLength(0);
  });

  it("caps the page size at 500 and defaults to 200", () => {
    expect(parseLimit(10_000)).toBe(500);
    expect(parseLimit(undefined)).toBe(200);
    expect(parseAfterId(undefined)).toBe(0);
  });
});

describe("tools/list", () => {
  async function listed(request?: Request, mode: "public" | "private" = "public") {
    const response = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, ENV, undefined, mode, request);
    return (response.result as { tools: { name: string }[] }).tools.map((t) => t.name);
  }

  it("hides concept_list from everyone but a platform service", async () => {
    expect(await listed()).not.toContain("concept_list");
    expect(await listed(asStranger())).not.toContain("concept_list");
    expect(await listed(asService())).toContain("concept_list");
  });

  it("keeps the other concept tools in the list for everyone", async () => {
    expect(await listed()).toEqual(expect.arrayContaining(["concept_status", "concept_search_by_name", "concept_expand", "graph_stats"]));
  });
});
