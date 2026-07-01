// MCP operating mode resolution for the unified knowledge/personal codebase.
// see ADR-IWE-018 (WP-410 Q1), erratum 2026-07-01.

export type McpMode = "public" | "private";

// Module-level latch so the unset warning fires once per isolate ("at startup"),
// not on every request — mirrors the _jwksCache pattern in index.ts.
let _unsetWarned = false;

/**
 * Resolve the MCP operating mode from the MCP_MODE environment binding.
 *
 * ADR-IWE-018 (erratum 2026-07-01) — default semantics split "unconfigured" from "misconfigured":
 *   unset / ""       -> "public"  (backward-compatible default; the base repo is the public corpus,
 *                                   which serves nothing private, so this opens no data hole)
 *   "public"         -> "public"
 *   "private"        -> "private"
 *   any other value  -> throw     (fail-closed on genuine misconfiguration; caller maps to HTTP 500)
 *
 * unset defaults to public but emits a WARN, so a future private deployment that forgot to set
 * MCP_MODE fails loudly in logs (it serves only NotImplemented for private tools, never private data).
 */
export function resolveMode(mode: string | undefined): McpMode {
  if (mode === undefined || mode === "") {
    if (!_unsetWarned) {
      console.warn("MCP_MODE unset, defaulting to public (set MCP_MODE=public explicitly to silence)");
      _unsetWarned = true;
    }
    return "public";
  }
  if (mode === "public" || mode === "private") {
    return mode;
  }
  throw new Error(`Invalid MCP_MODE: "${mode}" (expected "public" | "private")`);
}

// Test-only reset for the once-per-isolate warning latch.
export function _resetModeWarningForTest(): void {
  _unsetWarned = false;
}
