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
