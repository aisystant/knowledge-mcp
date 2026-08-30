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
  "delete",
  "memory_search",
  "connect_source",
  "disconnect_source",
  "purge_source",
  // Dispatched names are unprefixed like every other private tool here — gateway-mcp adds
  // "personal_" itself (routeToolCall strips it to get the backend name). A "personal_"-prefixed
  // dispatched name would collide after the gateway's strip (see index.ts comment on "reindex").
  "reindex",
  "reindex_status",
  // WP-7 Ф97.2: per-file indexing status (personal_index_status). Data layer
  // (buildIndexStatusSuccessQuery/writeIndexStatusError) lives in personal.ts;
  // the actual tools/list + dispatch entry is only wired in personal-knowledge-mcp's
  // src/index.ts so far — gateway-mcp routing for the private-mode path through
  // this worker is a known remainder, not yet done in this pass.
  "index_status",
]);

/**
 * Tools that exist in BOTH modes with a different backend (public corpus vs personal Neon
 * DB) — unlike PRIVATE_TOOL_NAMES, these are never refused; `isToolAllowedInMode` always
 * returns true for them. The dispatcher checks this set BEFORE its public-mode handler to
 * route to the private implementation without touching the public code path at all.
 */
export const DUAL_MODE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "search",
  "get_document",
  "list_sources",
]);

/**
 * Whether a tool may be invoked in the given mode. Private-only tools are refused in
 * public mode (they carry no public data path); everything else (public tools and
 * dual-mode tools) is allowed.
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
  /** false for source-scoped admin ops (disconnect_source/purge_source — no path arg by design).
   * Default true. See checkBridgeWriteScope's requiresPath doc (WP-410 Pre-Close checklist). */
  requiresPath?: boolean;
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
        requiresPath: opts.requiresPath,
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
