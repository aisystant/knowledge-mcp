// Tests for the private-mode authorization seam (WP-410 Q1 ADR-IWE-018, срез-2b).

import { describe, it, expect } from "vitest";
import {
  PRIVATE_TOOL_NAMES,
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
  });

  it("does not mark public tools as private", () => {
    expect(PRIVATE_TOOL_NAMES.has("search")).toBe(false);
    expect(PRIVATE_TOOL_NAMES.has("get_document")).toBe(false);
  });
});

describe("isToolAllowedInMode", () => {
  it("refuses a private tool in public mode", () => {
    expect(isToolAllowedInMode("write", "public")).toBe(false);
    expect(isToolAllowedInMode("propose_capture", "public")).toBe(false);
  });

  it("allows a private tool in private mode", () => {
    expect(isToolAllowedInMode("write", "private")).toBe(true);
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
