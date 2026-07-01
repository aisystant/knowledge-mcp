// Tests for MCP mode resolution (WP-410 Q1, ADR-IWE-018).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveMode, _resetModeWarningForTest } from "./mode.js";

describe("resolveMode", () => {
  beforeEach(() => {
    _resetModeWarningForTest();
    vi.restoreAllMocks();
  });

  it("defaults to public when MCP_MODE is unset", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveMode(undefined)).toBe("public");
  });

  it("defaults to public when MCP_MODE is empty string", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveMode("")).toBe("public");
  });

  it("returns public for explicit public", () => {
    expect(resolveMode("public")).toBe("public");
  });

  it("returns private for explicit private", () => {
    expect(resolveMode("private")).toBe("private");
  });

  it("throws (fail-closed) on unknown non-empty value", () => {
    expect(() => resolveMode("staging")).toThrow(/Invalid MCP_MODE/);
  });

  it("warns once per isolate on unset, not on every call", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveMode(undefined);
    resolveMode(undefined);
    resolveMode(undefined);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not warn for explicit modes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveMode("public");
    resolveMode("private");
    expect(warn).not.toHaveBeenCalled();
  });
});
