// Tests for the private-mode authorization seam (WP-410 Q1 ADR-IWE-018, срез-2b).

import { describe, it, expect } from "vitest";
import {
  PRIVATE_TOOL_NAMES,
  DUAL_MODE_TOOL_NAMES,
  isToolAllowedInMode,
  JwtScopeGuard,
  ScopeDeniedError,
} from "./private.js";

describe("PRIVATE_TOOL_NAMES", () => {
  it("declares the dispatched MCP tool names ported in срез-2b", () => {
    // Not "personal_write" — that's the canonical bridge-scope name (scope.ts), never the
    // dispatched toolName from tools/call. See private.ts comment on the slice-1 mismatch.
    expect(PRIVATE_TOOL_NAMES.has("write")).toBe(true);
    expect(PRIVATE_TOOL_NAMES.has("propose_capture")).toBe(true);
    expect(PRIVATE_TOOL_NAMES.has("delete")).toBe(true);
    expect(PRIVATE_TOOL_NAMES.has("memory_search")).toBe(true);
    expect(PRIVATE_TOOL_NAMES.has("connect_source")).toBe(true);
    // Деплой-2 группа А (peer-session 2026-07-01-29): admin tools ported with authorize gate.
    expect(PRIVATE_TOOL_NAMES.has("disconnect_source")).toBe(true);
    expect(PRIVATE_TOOL_NAMES.has("purge_source")).toBe(true);
    // Деплой-2 группа В (peer-session 2026-07-03-11): manual reindex trigger + status poll.
    // Unprefixed dispatched names — gateway-mcp adds "personal_" itself. A "personal_"-prefixed
    // dispatched name here would double up and route to the wrong backend tool (canary finding).
    expect(PRIVATE_TOOL_NAMES.has("reindex")).toBe(true);
    expect(PRIVATE_TOOL_NAMES.has("reindex_status")).toBe(true);
    expect(PRIVATE_TOOL_NAMES.has("personal_reindex_source")).toBe(false);
    expect(PRIVATE_TOOL_NAMES.has("personal_reindex_status")).toBe(false);
  });

  it("does not mark public tools as private", () => {
    expect(PRIVATE_TOOL_NAMES.has("search")).toBe(false);
    expect(PRIVATE_TOOL_NAMES.has("get_document")).toBe(false);
  });

  // WP-410 срез-2b turn 7-8 (peer-session 2026-07-01-27): tools/list and tools/call must never
  // drift apart — a name present in one MCP endpoint but not the other reproduces exactly the
  // "list says available, call refuses" class of bug Kimi flagged. PRIVATE_TOOLS (index.ts,
  // schemas for tools/list) and PRIVATE_TOOL_NAMES (this file, gate for tools/call) are two
  // separate literals kept in sync by hand — this guard fails loudly the day someone forgets one.
  it("is disjoint from DUAL_MODE_TOOL_NAMES (a tool is never both private-only and dual-mode)", () => {
    for (const name of PRIVATE_TOOL_NAMES) {
      expect(DUAL_MODE_TOOL_NAMES.has(name)).toBe(false);
    }
  });
});

describe("DUAL_MODE_TOOL_NAMES", () => {
  it("declares search/get_document/list_sources — same tool name, different backend by mode", () => {
    expect(DUAL_MODE_TOOL_NAMES.has("search")).toBe(true);
    expect(DUAL_MODE_TOOL_NAMES.has("get_document")).toBe(true);
    expect(DUAL_MODE_TOOL_NAMES.has("list_sources")).toBe(true);
  });

  it("does not include list_documents or memory_search (public-only / private-only respectively)", () => {
    expect(DUAL_MODE_TOOL_NAMES.has("list_documents")).toBe(false);
    expect(DUAL_MODE_TOOL_NAMES.has("memory_search")).toBe(false);
  });
});

describe("isToolAllowedInMode", () => {
  it("refuses a private tool in public mode", () => {
    expect(isToolAllowedInMode("write", "public")).toBe(false);
    expect(isToolAllowedInMode("propose_capture", "public")).toBe(false);
    expect(isToolAllowedInMode("delete", "public")).toBe(false);
    expect(isToolAllowedInMode("memory_search", "public")).toBe(false);
    expect(isToolAllowedInMode("connect_source", "public")).toBe(false);
  });

  it("allows a private tool in private mode", () => {
    expect(isToolAllowedInMode("write", "private")).toBe(true);
    expect(isToolAllowedInMode("connect_source", "private")).toBe(true);
  });

  it("allows dual-mode tools in both modes — never refused, only re-routed by mode", () => {
    for (const name of DUAL_MODE_TOOL_NAMES) {
      expect(isToolAllowedInMode(name, "public")).toBe(true);
      expect(isToolAllowedInMode(name, "private")).toBe(true);
    }
  });

  it("allows public tools in both modes", () => {
    expect(isToolAllowedInMode("search", "public")).toBe(true);
    expect(isToolAllowedInMode("search", "private")).toBe(true);
  });
});

describe("JwtScopeGuard.authenticate", () => {
  it("returns null when ORY_URL is not configured", async () => {
    const guard = new JwtScopeGuard(undefined);
    const result = await guard.authenticate(new Request("https://x/mcp"));
    expect(result).toBeNull();
  });

  it("returns null when the request carries no Bearer token", async () => {
    const guard = new JwtScopeGuard("https://auth.example.com/hydra");
    const result = await guard.authenticate(new Request("https://x/mcp"));
    expect(result).toBeNull();
  });

  it("returns null for a non-Bearer Authorization header", async () => {
    const guard = new JwtScopeGuard("https://auth.example.com/hydra");
    const result = await guard.authenticate(
      new Request("https://x/mcp", { headers: { Authorization: "Basic xyz" } })
    );
    expect(result).toBeNull();
  });
});

describe("JwtScopeGuard.authorize", () => {
  const principal = { userId: "11111111-1111-1111-1111-111111111111" };

  it("no-ops when scopeGuardMode is off (default)", async () => {
    const guard = new JwtScopeGuard("https://auth.example.com/hydra");
    // indicatorsDatabaseUrl intentionally malformed — if authorize touched it under mode=off,
    // neon() would throw synchronously and this test would fail.
    await expect(
      guard.authorize(principal, {
        toolName: "personal_write",
        args: {},
        indicatorsDatabaseUrl: "not-a-real-dsn",
        scopeGuardMode: "off",
      })
    ).resolves.toBeUndefined();
  });

  it("no-ops when indicatorsDatabaseUrl is not configured, even under enforce", async () => {
    const guard = new JwtScopeGuard("https://auth.example.com/hydra");
    await expect(
      guard.authorize(principal, {
        toolName: "personal_write",
        args: {},
        indicatorsDatabaseUrl: undefined,
        scopeGuardMode: "enforce",
      })
    ).resolves.toBeUndefined();
  });
});

describe("ScopeDeniedError", () => {
  it("carries the deny response verbatim for the caller to render", () => {
    const err = new ScopeDeniedError({
      allow: false,
      reason: "source_not_allowed",
      denyResponse: {
        code: -32001,
        message: "scope denied: source 'X' not allowed",
        data: { reason: "source_not_allowed", attempted_tool: "personal_write", attempted_source: "X" },
      },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.denyResponse.code).toBe(-32001);
    expect(err.denyResponse.data.reason).toBe("source_not_allowed");
  });
});
