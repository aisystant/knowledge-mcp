/**
 * scope.test.ts — fixture suite for the in-process scope guard (WP-410 срез-2b, ADR-IWE-019).
 *
 * Ported from personal-knowledge-mcp/src/scope.test.ts (peer-session 2026-07-01-21) — same
 * fixtures and assertions, rewritten from the standalone node:assert runner (that repo has no
 * test framework) to vitest, matching knowledge-mcp's existing test setup.
 *
 * Why a fixture suite (not live shadow): the gateway denies bridge write-tools BEFORE routing,
 * so a live shadow only ever sees gateway-ALLOWED traffic. Deny-path parity is therefore
 * verified deterministically here — every ScopeDenyReason + glob/dotfile/traversal edges +
 * peer-pilot fallback branches.
 */

import { describe, it, expect } from "vitest";
import {
  normalizePath,
  hasDotfileSegment,
  matchesGlob,
  extractBridgeSourcePath,
  checkBridgeWriteScope,
  shouldBlockOnScope,
  BRIDGE_WRITE_TOOLS,
  provisionBridgeScopes,
} from "./scope.js";

// --- neon sql mock: routes by query text (SELECT → scope rows, INSERT → []) ---
interface Row {
  allowed_repos: string[] | null;
  allowed_paths: string[] | null;
  allowed_operations: string[] | null;
  taint_level: number;
  revoked_at: string | null;
  expires_at: string | null;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSql(rows: Row[]): any {
  return (strings: TemplateStringsArray) =>
    strings.join(" ").includes("SELECT") ? Promise.resolve(rows) : Promise.resolve([]);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFailSql(): any {
  return (strings: TemplateStringsArray) =>
    strings.join(" ").includes("SELECT")
      ? Promise.reject(new Error("DB unavailable"))
      : Promise.resolve([]);
}
const okRow = (over: Partial<Row> = {}): Row => ({
  allowed_repos: ["DS-x"],
  allowed_paths: ["docs/**"],
  allowed_operations: ["write"],
  taint_level: 0,
  revoked_at: null,
  expires_at: null,
  ...over,
});

const BRIDGE_AGENT = "iwe_bridge:personal_write";
const base = {
  toolName: "personal_write",
  source: "DS-x" as string | undefined,
  path: "docs/a.md" as string | undefined,
  hasConflict: false,
  userId: "11111111-1111-1111-1111-111111111111",
  requireDeclaredAgentId: true,
  activeSources: ["DS-mine"],
};

describe("scope: pure functions", () => {
  it("normalizePath resolves .. traversal out of lesson/", () => {
    expect(normalizePath("lesson/../.claude/secrets")).toBe(".claude/secrets");
    expect(normalizePath("lesson/foo/../../etc/passwd")).toBe("etc/passwd");
  });

  it("normalizePath collapses slashes + strips leading slash + backslash", () => {
    expect(normalizePath("/lesson//foo.md")).toBe("lesson/foo.md");
    expect(normalizePath("lesson\\foo.md")).toBe("lesson/foo.md");
  });

  it("hasDotfileSegment detects dotfile dirs", () => {
    expect(hasDotfileSegment(".claude/secrets")).toBe(true);
    expect(hasDotfileSegment("docs/a.md")).toBe(false);
  });

  it("matchesGlob handles ** and *", () => {
    expect(matchesGlob("docs/a.md", "docs/**")).toBe(true);
    expect(matchesGlob("docs/deep/a.md", "docs/**")).toBe(true);
    expect(matchesGlob("secrets/a.md", "docs/**")).toBe(false);
    expect(matchesGlob("a.md", "**/*.md")).toBe(true);
  });

  it("extractBridgeSourcePath: source priority + suggested fallback + conflict", () => {
    expect(extractBridgeSourcePath({ source: "A", path: "p" })).toEqual({ source: "A", path: "p", hasConflict: false });
    expect(extractBridgeSourcePath({ suggested_source: "B", suggested_path: "q" })).toEqual({ source: "B", path: "q", hasConflict: false });
    expect(extractBridgeSourcePath({ source: "A", suggested_source: "B" }).hasConflict).toBe(true);
    expect(extractBridgeSourcePath({ path: "p", suggested_path: "q" }).hasConflict).toBe(true);
  });

  it("BRIDGE_WRITE_TOOLS holds canonical names", () => {
    expect(BRIDGE_WRITE_TOOLS.has("personal_write")).toBe(true);
    expect(BRIDGE_WRITE_TOOLS.has("personal_propose_capture")).toBe(true);
    expect(BRIDGE_WRITE_TOOLS.has("write")).toBe(false);
  });
});

describe("checkBridgeWriteScope: allow path", () => {
  it("allows when declared agent + source/path in scope", async () => {
    const r = await checkBridgeWriteScope({ ...base, agentId: BRIDGE_AGENT, indicatorsSql: makeSql([okRow()]) });
    expect(r.allow).toBe(true);
    expect(r.reason).toBe("ok");
  });
});

describe("checkBridgeWriteScope: deny reasons", () => {
  it("scope_not_found: SELECT returns no row", async () => {
    const r = await checkBridgeWriteScope({ ...base, agentId: BRIDGE_AGENT, indicatorsSql: makeSql([]) });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("scope_not_found");
    expect(r.denyResponse?.data.reason).toBe("scope_not_found");
  });

  it("scope_revoked: revoked_at set", async () => {
    const r = await checkBridgeWriteScope({ ...base, agentId: BRIDGE_AGENT, indicatorsSql: makeSql([okRow({ revoked_at: "2026-01-01T00:00:00Z" })]) });
    expect(r.reason).toBe("scope_revoked");
  });

  it("scope_expired: expires_at in past", async () => {
    const r = await checkBridgeWriteScope({ ...base, agentId: BRIDGE_AGENT, indicatorsSql: makeSql([okRow({ expires_at: "2000-01-01T00:00:00Z" })]) });
    expect(r.reason).toBe("scope_expired");
  });

  it("operation_not_allowed: write not in allowed_operations", async () => {
    const r = await checkBridgeWriteScope({ ...base, agentId: BRIDGE_AGENT, indicatorsSql: makeSql([okRow({ allowed_operations: ["propose"] })]) });
    expect(r.reason).toBe("operation_not_allowed");
  });

  it("source_not_allowed: source not in allowed_repos", async () => {
    const r = await checkBridgeWriteScope({ ...base, source: "DS-other", agentId: BRIDGE_AGENT, indicatorsSql: makeSql([okRow()]) });
    expect(r.reason).toBe("source_not_allowed");
  });

  it("path_not_allowed: path not in allowed_paths glob", async () => {
    const r = await checkBridgeWriteScope({ ...base, path: "secrets/x.md", agentId: BRIDGE_AGENT, indicatorsSql: makeSql([okRow()]) });
    expect(r.reason).toBe("path_not_allowed");
  });

  it("invalid_agent_id: declared mismatch (no DB hit)", async () => {
    const r = await checkBridgeWriteScope({ ...base, agentId: "iwe_bridge:wrong", indicatorsSql: makeFailSql() });
    expect(r.reason).toBe("invalid_agent_id");
  });

  it("source_not_allowed on hasConflict (no DB hit)", async () => {
    const r = await checkBridgeWriteScope({ ...base, hasConflict: true, agentId: BRIDGE_AGENT, indicatorsSql: makeFailSql() });
    expect(r.reason).toBe("source_not_allowed");
  });

  it("indicators_db_unavailable: SELECT throws", async () => {
    const r = await checkBridgeWriteScope({ ...base, agentId: BRIDGE_AGENT, indicatorsSql: makeFailSql() });
    expect(r.reason).toBe("indicators_db_unavailable");
  });
});

describe("checkBridgeWriteScope: peer-pilot fallback (declaredAgentId missing + requireDeclaredAgentId)", () => {
  it("missing path → deny path_not_allowed", async () => {
    const r = await checkBridgeWriteScope({ ...base, agentId: undefined, path: undefined, indicatorsSql: makeSql([]) });
    expect(r.reason).toBe("path_not_allowed");
  });

  it("dotfile path → deny path_not_allowed", async () => {
    const r = await checkBridgeWriteScope({ ...base, agentId: undefined, source: "DS-mine", path: ".claude/x", indicatorsSql: makeSql([]) });
    expect(r.reason).toBe("path_not_allowed");
  });

  it("source not in activeSources → deny source_not_allowed", async () => {
    const r = await checkBridgeWriteScope({ ...base, agentId: undefined, source: "DS-other", path: "notes/x.md", indicatorsSql: makeSql([]) });
    expect(r.reason).toBe("source_not_allowed");
  });

  it("own-data widen (source in activeSources) → allow with scope row", async () => {
    const r = await checkBridgeWriteScope({ ...base, agentId: undefined, source: "DS-mine", path: "notes/x.md", indicatorsSql: makeSql([okRow({ allowed_repos: ["DS-mine"] })]) });
    expect(r.allow).toBe(true);
  });

  it("continuation default (personal-guide/lesson/) → allow with scope row", async () => {
    const r = await checkBridgeWriteScope({ ...base, agentId: undefined, source: "personal-guide", path: "lesson/2026-06-01.md", indicatorsSql: makeSql([okRow({ allowed_repos: ["personal-guide"], allowed_paths: ["lesson/**"] })]) });
    expect(r.allow).toBe(true);
  });
});

// Records the scope-grant provisioning INSERT (self-heal) separately from the scope lookup and
// the audit-violation log — routing by "SELECT" substring alone is NOT enough: the provisioning
// INSERT's own ON CONFLICT clause contains a nested `SELECT DISTINCT unnest(...)`, so a naive
// includes("SELECT") check misclassifies it as the lookup query. Route by table name instead.
// Shared by the self-heal and requiresPath describe blocks below (WP-410 Pre-Close checklist,
// session 2026-07-03-18).
function makeSelfHealSql(opts: { provisionRejects?: boolean } = {}): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sql: any;
  provisionCalls: unknown[][];
} {
  const provisionCalls: unknown[][] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ");
    if (text.includes("FROM agent_scopes_mvp")) return Promise.resolve([]); // scope lookup: no row
    if (text.includes("INSERT INTO agent_scopes_mvp")) {
      if (opts.provisionRejects) return Promise.reject(new Error("provision failed"));
      provisionCalls.push(values);
      return Promise.resolve([]);
    }
    return Promise.resolve([]); // agent_scope_violations audit log — not under test here
  };
  return { sql, provisionCalls };
}

// Stateful variant: SELECT starts empty, then returns a matching row once the fallback agent_id
// has been provisioned — simulates a real DB across two sequential calls, to verify self-heal
// actually converges (cold-review finding, session 2026-07-03-18: provisionBridgeScopes was
// missing the PEER_PILOT_AGENT_ID row, so the SELECT here would have kept returning [] forever
// even after "successful" self-heal, meaning every fallback call re-provisioned from scratch).
function makeConvergingFallbackSql() {
  let provisionedForFallback = false;
  let provisionCallCount = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ");
    if (text.includes("FROM agent_scopes_mvp")) {
      return Promise.resolve(provisionedForFallback ? [okRow({ allowed_repos: ["DS-mine"], allowed_operations: ["write", "propose"] })] : []);
    }
    if (text.includes("INSERT INTO agent_scopes_mvp")) {
      provisionCallCount += 1;
      if (values.includes("pilot-helper-in-environment")) provisionedForFallback = true;
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  return { sql, getProvisionCallCount: () => provisionCallCount };
}

// WP-410 Pre-Close checklist (session 2026-07-03-18): two regressions found by comparing this
// file against personal-knowledge-mcp/src/scope.ts (the pre-unification original) — (1) the
// self-heal branch (commit 051edf7) that provisions a fallback scope row on first proven-ownership
// write was dropped during the port, so any user without a pre-existing row got permanently denied
// (reproduces the original externally-reported bug); (2) `if (!path) deny` fired unconditionally
// for the peer-pilot fallback, before the ownership check, so disconnect_source/purge_source
// (which carry no path by design) could never succeed for a client without a declared agent_id.
describe("checkBridgeWriteScope: peer-pilot self-heal (WP-410 Pre-Close checklist, restores 051edf7)", () => {
  it("own-data widen + no existing row → self-heals (provisions) and allows", async () => {
    const { sql, provisionCalls } = makeSelfHealSql();
    const r = await checkBridgeWriteScope({ ...base, agentId: undefined, source: "DS-mine", path: "notes/x.md", indicatorsSql: sql });
    expect(r.allow).toBe(true);
    expect(provisionCalls).toHaveLength(1);
    expect(provisionCalls[0]).toContainEqual(["DS-mine"]); // allowedRepos, per provisionBridgeScopes' own test
  });

  it("continuation default + no existing row → self-heals and allows", async () => {
    const { sql, provisionCalls } = makeSelfHealSql();
    const r = await checkBridgeWriteScope({ ...base, agentId: undefined, source: "personal-guide", path: "lesson/2026-06-01.md", indicatorsSql: sql });
    expect(r.allow).toBe(true);
    expect(provisionCalls).toHaveLength(1);
  });

  it("self-heal INSERT fails → denies scope_not_found instead of throwing", async () => {
    const { sql } = makeSelfHealSql({ provisionRejects: true });
    const r = await checkBridgeWriteScope({ ...base, agentId: undefined, source: "DS-mine", path: "notes/x.md", indicatorsSql: sql });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("scope_not_found");
  });

  it("source NOT owned + no existing row → still denies source_not_allowed, no self-heal attempted", async () => {
    const { sql, provisionCalls } = makeSelfHealSql();
    const r = await checkBridgeWriteScope({ ...base, agentId: undefined, source: "DS-other", path: "notes/x.md", indicatorsSql: sql });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("source_not_allowed");
    expect(provisionCalls).toHaveLength(0);
  });

  it("second call after self-heal finds the provisioned row instead of re-provisioning", async () => {
    const { sql, getProvisionCallCount } = makeConvergingFallbackSql();
    const r1 = await checkBridgeWriteScope({ ...base, agentId: undefined, source: "DS-mine", path: "notes/a.md", indicatorsSql: sql });
    expect(r1.allow).toBe(true);
    expect(getProvisionCallCount()).toBe(1);

    const r2 = await checkBridgeWriteScope({ ...base, agentId: undefined, source: "DS-mine", path: "notes/b.md", indicatorsSql: sql });
    expect(r2.allow).toBe(true);
    expect(getProvisionCallCount()).toBe(1); // unchanged — second call found the row, didn't re-provision
  });
});

describe("checkBridgeWriteScope: requiresPath=false (disconnect_source/purge_source, WP-410 Pre-Close checklist)", () => {
  it("no path + own source → skips the path gate, reaches ownership check, allows (via self-heal)", async () => {
    const { sql } = makeSelfHealSql();
    const r = await checkBridgeWriteScope({
      ...base, agentId: undefined, source: "DS-mine", path: undefined,
      requiresPath: false, indicatorsSql: sql,
    });
    expect(r.allow).toBe(true);
  });

  it("no path + NOT own source → still denies source_not_allowed (ordering fix doesn't open a hole)", async () => {
    const r = await checkBridgeWriteScope({
      ...base, agentId: undefined, source: "DS-other", path: undefined,
      requiresPath: false, indicatorsSql: makeSql([]),
    });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("source_not_allowed");
  });

  it("requiresPath defaults to true — write/delete unaffected, still deny on missing path", async () => {
    const r = await checkBridgeWriteScope({ ...base, agentId: undefined, path: undefined, indicatorsSql: makeSql([]) });
    expect(r.reason).toBe("path_not_allowed");
  });
});

describe("checkBridgeWriteScope: violation logging includes repo/path (WP-410 Pre-Close checklist)", () => {
  it("scope_not_found (declared agent, no self-heal path) logs attempted_repo", async () => {
    const inserts: unknown[][] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join(" ").includes("SELECT")) return Promise.resolve([]);
      inserts.push(values);
      return Promise.resolve([]);
    };
    await checkBridgeWriteScope({ ...base, agentId: BRIDGE_AGENT, indicatorsSql: sql });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain("DS-x"); // base.source — previously never logged for this reason
  });
});

describe("shouldBlockOnScope: enforce fail-open classification (WP-410, peer-session 2026-06-15-16)", () => {
  it("every explicit scope-denial reason blocks in enforce", () => {
    for (const reason of [
      "scope_not_found", "scope_revoked", "scope_expired",
      "operation_not_allowed", "source_not_allowed", "path_not_allowed", "invalid_agent_id",
    ] as const) {
      expect(shouldBlockOnScope(reason)).toBe(true);
    }
  });

  it("indicators_db_unavailable does NOT block (infra → fail open)", () => {
    expect(shouldBlockOnScope("indicators_db_unavailable")).toBe(false);
  });

  it("ok never blocks", () => {
    expect(shouldBlockOnScope("ok")).toBe(false);
  });
});

describe("provisionBridgeScopes (WP-410 срез-2b, connect_source)", () => {
  it("upserts both bridge scope rows for the given user/source", async () => {
    const calls: { strings: string; values: unknown[] }[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recordingSql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ strings: strings.join("?"), values });
      return Promise.resolve([]);
    };

    await provisionBridgeScopes(recordingSql, "user-1", "DS-my-strategy");

    expect(calls).toHaveLength(1);
    const [{ strings, values }] = calls;
    expect(strings).toContain("INSERT INTO agent_scopes_mvp");
    expect(strings).toContain("ON CONFLICT (agent_id, user_id) DO UPDATE SET");
    // Interpolated values, in template order: userId, allowedRepos, userId, allowedRepos.
    expect(values).toContain("user-1");
    expect(values).toContainEqual(["DS-my-strategy"]);
  });
});
