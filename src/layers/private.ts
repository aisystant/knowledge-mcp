// Authorization seam for the private MCP mode (unified knowledge/personal codebase).
// see ADR-IWE-018 (WP-410 Q1), ADR-mcp-unification-q1 (срез-2b).
//
// Slice 2b ports the real Ory-JWT authentication and per-user scope enforcement
// extracted from personal-knowledge-mcp (src/index.ts: write, propose_capture;
// src/scope.ts: checkBridgeWriteScope).

import { neon } from "@neondatabase/serverless";
import type { McpMode } from "../mode.js";
import { extractBearerToken, verifyJwtLocally } from "../auth.js";
import {
  checkBridgeWriteScope,
  extractBridgeSourcePath,
  shouldBlockOnScope,
  type ScopeCheckResult,
} from "../scope.js";

export interface Principal {
  userId: string;
}

/**
 * Tools that only exist in the private corpus. In public mode a call to any of
 * these must be refused before dispatch (they carry no public data path).
 *
 * Names here are the dispatched MCP tool names (params.name in tools/call), NOT the
 * canonical bridge-scope names used internally by scope.ts (personal_write /
 * personal_propose_capture) — those are a separate vocabulary for agent_scopes_mvp rows.
 * Slice-1 declared "personal_write" here, which never matches an actual dispatched
 * toolName ("write") and would have left the private write tool unguarded by mode once
 * wired up — fixed in slice 2b before any caller existed.
 */
export const PRIVATE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write",
  "propose_capture",
]);

/**
 * Whether a tool may be invoked in the given mode. Private-only tools are refused in
 * public mode (they carry no public data path); everything else is allowed.
 */
export function isToolAllowedInMode(toolName: string, mode: McpMode): boolean {
  return !(mode === "public" && PRIVATE_TOOL_NAMES.has(toolName));
}

/** JSON-RPC error shape shared by auth failures and scope denials — same rendering path. */
export interface GuardDenyResponse {
  code: number;
  message: string;
  data: {
    reason: string;
    attempted_tool: string;
    attempted_source?: string;
    attempted_path?: string;
  };
}

/** Thrown by PrivateGuard.authorize on scope denial. Callers render `.denyResponse` verbatim. */
export class ScopeDeniedError extends Error {
  denyResponse: GuardDenyResponse;
  constructor(result: ScopeCheckResult & { denyResponse: GuardDenyResponse }) {
    super(result.denyResponse.message);
    this.name = "ScopeDeniedError";
    this.denyResponse = result.denyResponse;
  }
}

export interface AuthorizeOpts {
  toolName: string;                 // canonical: personal_write | personal_propose_capture
  args: Record<string, unknown>;
  requestId?: string;
  activeSources?: string[];
  /** Neon `indicators` DB connection string. Only read when scopeGuardMode != "off". */
  indicatorsDatabaseUrl: string | undefined;
  scopeGuardMode: string | undefined; // "off" | "shadow" | "enforce" — mirrors env.SCOPE_GUARD_MODE
}

/**
 * Authorization contract for private-mode requests.
 */
export interface PrivateGuard {
  /** Resolve the caller principal from the request, or null if unauthenticated. */
  authenticate(request: Request): Promise<Principal | null>;
  /** Throw ScopeDeniedError if the principal may not invoke the given private tool. */
  authorize(principal: Principal, opts: AuthorizeOpts): Promise<void>;
}

/** Real slice-2b guard: Ory JWT authentication + indicators-DB scope authorization. */
export class JwtScopeGuard implements PrivateGuard {
  constructor(private oryUrl: string | undefined) {}

  async authenticate(request: Request): Promise<Principal | null> {
    if (!this.oryUrl) return null;
    const token = extractBearerToken(request);
    if (!token) return null;
    const userId = await verifyJwtLocally(this.oryUrl, token);
    return userId ? { userId } : null;
  }

  async authorize(principal: Principal, opts: AuthorizeOpts): Promise<void> {
    const mode = opts.scopeGuardMode ?? "off";
    // Faithful port of runScopeGuard's early-out (personal-knowledge-mcp/src/index.ts:257-260):
    // missing INDICATORS_DATABASE_URL is treated the same as mode="off" (silent no-op), not an
    // infra failure to alarm on — this is inherited prod behavior, not a new design choice.
    if (mode === "off" || !opts.indicatorsDatabaseUrl) return;

    const { source, path, hasConflict } = extractBridgeSourcePath(opts.args);
    const declaredAgentId = opts.args._meta && typeof (opts.args._meta as Record<string, unknown>).agent_id === "string"
      ? ((opts.args._meta as Record<string, unknown>).agent_id as string)
      : undefined;

    let result: ScopeCheckResult;
    try {
      result = await checkBridgeWriteScope({
        toolName: opts.toolName,
        source,
        path,
        hasConflict,
        userId: principal.userId,
        agentId: declaredAgentId,
        requestId: opts.requestId,
        requireDeclaredAgentId: true,
        activeSources: opts.activeSources,
        indicatorsSql: neon(opts.indicatorsDatabaseUrl),
      });
    } catch (err) {
      console.error(JSON.stringify({
        phase: "scope_guard_error",
        severity: "warning",
        mode,
        user_id_prefix: principal.userId.slice(0, 8),
        error: err instanceof Error ? err.message : String(err),
      }));
      result = {
        allow: false,
        reason: "indicators_db_unavailable",
        denyResponse: {
          code: -32001,
          message: "scope denied: indicators DB error",
          data: { reason: "indicators_db_unavailable", attempted_tool: opts.toolName },
        },
      };
    }

    console.log(JSON.stringify({
      phase: mode === "enforce" ? "scope_enforce" : "scope_shadow",
      request_id: opts.requestId ?? null,
      user_id_prefix: principal.userId.slice(0, 8),
      tool: opts.toolName,
      source: source ?? null,
      path: path ?? null,
      declared_agent_id: declaredAgentId ?? null,
      verdict: result.allow ? "allow" : "deny",
      reason: result.reason,
    }));

    if (mode !== "enforce" || result.allow) return; // shadow/off never block; allow never blocks

    if (shouldBlockOnScope(result.reason)) {
      throw new ScopeDeniedError(result as ScopeCheckResult & { denyResponse: GuardDenyResponse });
    }
    // Infra failure under enforce → fail open with a loud alarm (a single pooled-endpoint
    // flap must not block every write for every user).
    console.error(JSON.stringify({
      phase: "scope_fail_open",
      severity: "error",
      tag: "scope_fail_open",
      user_id_prefix: principal.userId.slice(0, 8),
      tool: opts.toolName,
      reason: result.reason,
    }));
  }
}
