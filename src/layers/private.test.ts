// Tests for the private-mode authorization seam (WP-410 Q1, ADR-IWE-018).

import { describe, it, expect } from "vitest";
import {
  PRIVATE_TOOL_NAMES,
  isToolAllowedInMode,
  NotImplementedGuard,
} from "./private.js";

describe("PRIVATE_TOOL_NAMES", () => {
  it("declares the private-only tools ported in slice 2", () => {
    expect(PRIVATE_TOOL_NAMES.has("personal_write")).toBe(true);
    expect(PRIVATE_TOOL_NAMES.has("propose_capture")).toBe(true);
  });

  it("does not mark public tools as private", () => {
    expect(PRIVATE_TOOL_NAMES.has("search")).toBe(false);
    expect(PRIVATE_TOOL_NAMES.has("get_document")).toBe(false);
  });
});

describe("isToolAllowedInMode", () => {
  it("refuses a private tool in public mode", () => {
    expect(isToolAllowedInMode("personal_write", "public")).toBe(false);
  });

  it("allows a private tool in private mode", () => {
    expect(isToolAllowedInMode("personal_write", "private")).toBe(true);
  });

  it("allows public tools in both modes", () => {
    expect(isToolAllowedInMode("search", "public")).toBe(true);
    expect(isToolAllowedInMode("search", "private")).toBe(true);
  });
});

describe("NotImplementedGuard", () => {
  it("throws NotImplemented on authenticate (slice 1 stub)", async () => {
    const guard = new NotImplementedGuard();
    await expect(guard.authenticate(new Request("https://x/mcp"))).rejects.toThrow(/not implemented/i);
  });

  it("throws NotImplemented on authorize (slice 1 stub)", () => {
    const guard = new NotImplementedGuard();
    expect(() => guard.authorize({ userId: "u1" }, "personal_write")).toThrow(/not implemented/i);
  });
});
