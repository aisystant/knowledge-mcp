/**
 * English-name fields as the gateway tools return them (WP-596 F67).
 *
 * The tools run through handleMcpRequest with a mocked database driver that records the
 * SQL text. Two things are checked that the pure-function tests cannot see: the queries
 * still select the name_en columns, and the four fields reach the response of every tool.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMcpRequest } from "./index.js";
import type { Env } from "./index.js";
import { NAME_EN_BLANK_CHARS, NAME_EN_PUBLISHABLE_RULES_VERSION } from "./name-en-publishable.js";
import { readEtalon } from "./test-support/f67-etalon.js";

type Call = { text: string; values: unknown[] };
type Responder = (call: Call) => unknown[];

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

const ENV = { KNOWLEDGE_DATABASE_URL: "postgres://example" } as Env;

function setResponder(responder: Responder) {
  state.responder = responder;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await handleMcpRequest(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    ENV,
  );
  const result = response.result as { content: { text: string }[] };
  return JSON.parse(result.content[0]!.text);
}

const isUsageLog = (call: Call) => call.text.includes("INSERT");

function conceptRow(overrides: Record<string, unknown>) {
  return {
    id: 7,
    code: "ZP.1",
    name: "Аксиоматичность",
    status: "active",
    misconception: false,
    superseded_by: null,
    superseded_by_code: null,
    superseded_by_name: null,
    level: "zp",
    domain: null,
    definition: "def",
    ...overrides,
  };
}

beforeEach(() => {
  calls.length = 0;
  setResponder(() => []);
});

describe("concept_status", () => {
  it("answers every code of the acceptance table as the table says", async () => {
    const etalon = readEtalon();
    expect(etalon).toHaveLength(19);
    for (const row of etalon) {
      setResponder((call) => {
        if (isUsageLog(call) || row.dbRow === null) return [];
        return [conceptRow({ code: row.code, ...row.dbRow })];
      });
      const got = await callTool("concept_status", { code: row.code });
      if (row.dbRow === null) {
        expect(got, row.code).toEqual({ not_found: true });
        continue;
      }
      expect(got, row.code).toMatchObject({
        code: row.code,
        name_en: row.dbRow.name_en,
        name_en_status_raw: row.dbRow.name_en_status,
        name_en_publishable: row.publishable,
        name_en_publishable_rules_version: row.rulesVersion,
      });
      expect(got, row.code).not.toHaveProperty("name_en_status");
    }
  });

  it("keeps the old fields of the concept", async () => {
    setResponder((call) => (isUsageLog(call) ? [] : [conceptRow({ name_en: "Axiomaticity", name_en_status: "ok" })]));
    expect(await callTool("concept_status", { code: "ZP.1" })).toEqual({
      id: 7,
      code: "ZP.1",
      name: "Аксиоматичность",
      status: "active",
      misconception: false,
      superseded_by: null,
      superseded_by_code: null,
      superseded_by_name: null,
      level: "zp",
      domain: null,
      definition: "def",
      name_en: "Axiomaticity",
      name_en_status_raw: "ok",
      name_en_publishable: true,
      name_en_publishable_rules_version: NAME_EN_PUBLISHABLE_RULES_VERSION,
    });
  });

  it.each([
    ["concept_id", { concept_id: 7 }],
    ["code", { code: "ZP.1" }],
    ["name", { name: "Аксиоматичность" }],
  ])("selects the name_en columns when looking up by %s", async (_kind, args) => {
    setResponder((call) => (isUsageLog(call) ? [] : [conceptRow({ name_en: "Axiomaticity", name_en_status: "ok" })]));
    const got = await callTool("concept_status", args);
    expect(got).toMatchObject({ name_en: "Axiomaticity", name_en_publishable: true });
    const select = calls.find((call) => call.text.includes("SELECT c.id"));
    expect(select?.text).toContain("c.name_en, c.name_en_status");
  });

  it("turns a missing database column into null, null, false instead of failing", async () => {
    setResponder((call) => (isUsageLog(call) ? [] : [conceptRow({})]));
    expect(await callTool("concept_status", { code: "ZP.1" })).toMatchObject({
      name_en: null,
      name_en_status_raw: null,
      name_en_publishable: false,
    });
  });
});

describe("concept_search_by_name", () => {
  it("returns the four fields on every hit and keeps similarity", async () => {
    setResponder((call) => {
      if (isUsageLog(call)) return [];
      return [
        { ...conceptRow({ name_en: "Axiomaticity", name_en_status: "ok" }), similarity: 0.9 },
        { ...conceptRow({ id: 8, code: "ZP.2", name_en: null, name_en_status: "ok" }), similarity: 0.5 },
      ];
    });
    const hits = (await callTool("concept_search_by_name", { name: "аксиом" })) as Record<string, unknown>[];
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ code: "ZP.1", similarity: 0.9, name_en: "Axiomaticity", name_en_publishable: true });
    expect(hits[1]).toMatchObject({ code: "ZP.2", similarity: 0.5, name_en: null, name_en_status_raw: "ok", name_en_publishable: false });
    for (const hit of hits) {
      expect(hit).not.toHaveProperty("name_en_status");
      expect(hit.name_en_publishable_rules_version).toBe(NAME_EN_PUBLISHABLE_RULES_VERSION);
    }
    const select = calls.find((call) => call.text.includes("similarity(c.name"));
    expect(select?.text).toContain("c.name_en, c.name_en_status");
  });
});

describe("concept_expand", () => {
  it("puts the four fields on neighbours found in both directions", async () => {
    setResponder((call) => {
      if (!call.text.includes("fc.name_en AS fc_name_en")) return [];
      return [
        {
          edge_id: 1, from_concept_id: 1, to_concept_id: 2, edge_type: "related", weight: 0.9,
          fc_id: 1, fc_code: "A", fc_name: "A", fc_status: "active", fc_misc: false, fc_level: "pack", fc_domain: null,
          fc_name_en: "Alpha", fc_name_en_status: "ok",
          tc_id: 2, tc_code: "B", tc_name: "B", tc_status: "active", tc_misc: false, tc_level: "pack", tc_domain: null,
          tc_name_en: "Beta", tc_name_en_status: "pending",
        },
        {
          edge_id: 2, from_concept_id: 3, to_concept_id: 1, edge_type: "part_of", weight: 0.7,
          fc_id: 3, fc_code: "C", fc_name: "C", fc_status: "active", fc_misc: false, fc_level: "pack", fc_domain: null,
          fc_name_en: "Gamma", fc_name_en_status: "ok",
          tc_id: 1, tc_code: "A", tc_name: "A", tc_status: "active", tc_misc: false, tc_level: "pack", tc_domain: null,
          tc_name_en: "Alpha", tc_name_en_status: "ok",
        },
      ];
    });
    const got = (await callTool("concept_expand", { concept_ids: [1] })) as { neighbors: Record<string, unknown>[] };
    const byCode = Object.fromEntries(got.neighbors.map((n) => [n.code as string, n]));
    expect(byCode.B).toMatchObject({ direction: "out", name_en: "Beta", name_en_status_raw: "pending", name_en_publishable: false });
    expect(byCode.C).toMatchObject({ direction: "in", name_en: "Gamma", name_en_status_raw: "ok", name_en_publishable: true });
    for (const neighbor of got.neighbors) {
      expect(neighbor.name_en_publishable_rules_version).toBe(NAME_EN_PUBLISHABLE_RULES_VERSION);
      expect(Object.keys(neighbor).slice(-4)).toEqual([
        "name_en", "name_en_status_raw", "name_en_publishable", "name_en_publishable_rules_version",
      ]);
    }
  });
});

describe("graph_stats", () => {
  const AS_OF = new Date("2026-11-01T15:13:06.612Z");

  function statsResponder(conceptRowOverride: Record<string, unknown>): Responder {
    return (call) => {
      if (call.text.includes("name_en_publishable_count")) {
        return [{
          cnt: 5788, name_en_publishable_count: 3308,
          hidden_by_closed_sources_count: 120, name_en_publishable_hidden_count: 90,
          as_of: AS_OF, ...conceptRowOverride,
        }];
      }
      return [{ cnt: 1 }];
    };
  }

  it("adds the count, the share of active concepts and the snapshot mark", async () => {
    setResponder(statsResponder({}));
    const got = (await callTool("graph_stats", {})) as Record<string, unknown>;
    expect(got).toMatchObject({
      concepts: 5788,
      name_en_publishable_count: 3308,
      name_en_publishable_share: 0.571527,
      as_of: "2026-11-01T15:13:06.612Z",
    });
  });

  it("reports how many concepts the closed-source list hides, so a snapshot can be reconciled", async () => {
    setResponder(statsResponder({}));
    const got = (await callTool("graph_stats", {})) as Record<string, number>;
    expect(got.hidden_by_closed_sources_count).toBe(120);
    expect(got.name_en_publishable_hidden_count).toBe(90);
    // rows visible through the gateway = concepts - hidden; publishable among them = count - hidden publishable
    expect(got.concepts - got.hidden_by_closed_sources_count).toBe(5668);
    expect(got.name_en_publishable_count - got.name_en_publishable_hidden_count).toBe(3218);
    const count = calls.find((call) => call.text.includes("name_en_publishable_count"));
    expect(count?.text).toContain("source_repo = ANY(?::text[])");
    expect(count?.values.some((v) => Array.isArray(v) && v.includes("PACK-verification") && v.includes("PACK-agent-rules"))).toBe(true);
  });

  it("counts with the same blank characters and status that nameEnFields uses", async () => {
    setResponder(statsResponder({}));
    await callTool("graph_stats", {});
    const count = calls.find((call) => call.text.includes("name_en_publishable_count"));
    expect(count?.text).toContain("btrim(name_en, ?)");
    expect(count?.values).toContain(NAME_EN_BLANK_CHARS);
    expect(count?.values).toContain("ok");
  });

  it("returns the whole statistics with the worker clock when the database mark does not parse", async () => {
    setResponder(statsResponder({ as_of: null }));
    const before = Date.now();
    const got = (await callTool("graph_stats", {})) as Record<string, unknown>;
    expect(got.concepts).toBe(5788);
    expect(Date.parse(got.as_of as string)).toBeGreaterThanOrEqual(before);
  });

  it("gives a zero share when there are no active concepts", async () => {
    setResponder(statsResponder({ cnt: 0, name_en_publishable_count: 0 }));
    const got = (await callTool("graph_stats", {})) as Record<string, unknown>;
    expect(got).toMatchObject({ concepts: 0, name_en_publishable_count: 0, name_en_publishable_share: 0 });
  });
});
