// Authorization seam for the private MCP mode (unified knowledge/personal codebase).
// see ADR-IWE-018 (WP-410 Q1).
//
// Slice 1 ships the typed contract with a stub implementation so the public path
// knows the seam without any private data path existing yet. Slice 2 will port the
// real Ory-JWT authentication and per-user scope enforcement extracted from
// personal-knowledge-mcp (src/index.ts: personal_write, propose_capture; src/scope.ts: guard).

import type { McpMode } from "../mode.js";

export interface Principal {
  userId: string;
}

/**
 * Tools that only exist in the private corpus. In public mode a call to any of
 * these must be refused before dispatch (they carry no public data path).
 *
 * Declared now (slice 1) so the public-mode refusal and its negative tests are real;
 * their implementations are ported in slice 2.
 */
export const PRIVATE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "personal_write",
  "propose_capture",
]);

/**
 * Whether a tool may be invoked in the given mode. Private-only tools are refused in
 * public mode (they carry no public data path); everything else is allowed. Slice 2
 * reuses this predicate to route private tools through the PrivateGuard.
 */
export function isToolAllowedInMode(toolName: string, mode: McpMode): boolean {
  return !(mode === "public" && PRIVATE_TOOL_NAMES.has(toolName));
}

/**
 * Authorization contract for private-mode requests.
 * Slice 2 replaces NotImplementedGuard with the real implementation behind this interface.
 */
export interface PrivateGuard {
  /** Resolve the caller principal from the request, or null if unauthenticated. */
  authenticate(request: Request): Promise<Principal | null>;
  /** Throw if the principal may not invoke the given private tool. */
  authorize(principal: Principal, toolName: string): void;
}

/** Slice-1 stub: private mode is not yet implemented in this build. */
export class NotImplementedGuard implements PrivateGuard {
  async authenticate(_request: Request): Promise<Principal | null> {
    throw new Error("Private mode not implemented in this build (WP-410 Q1 slice 1)");
  }

  authorize(_principal: Principal, _toolName: string): void {
    throw new Error("Private mode not implemented in this build (WP-410 Q1 slice 1)");
  }
}
