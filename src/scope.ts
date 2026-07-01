/**
 * scope.ts — In-process scope enforcement for bridge write-tools (WP-410 срез-2b).
 * see DP.SC.165, ADR-IWE-019, ADR-mcp-unification-q1.
 *
 * Ported from personal-knowledge-mcp/src/scope.ts (peer-session 2026-07-01-21) as-is —
 * faithful port, no behavior change. That file itself was ported from
 * bridge-scope-service/src/scope.ts (which itself was ported from gateway).
 */

import { neon } from "@neondatabase/serverless";

/** neon() tagged-template client (HTTP driver). Returns rows array directly. */
type NeonSql = ReturnType<typeof neon>;

/** Bridge write-tools whitelist (canonical gateway-tool names). Расширение требует update DP.SC.165. */
export const BRIDGE_WRITE_TOOLS = new Set<string>([
  "personal_write",
  "personal_propose_capture",
]);

const PEER_PILOT_AGENT_ID = "pilot-helper-in-environment";
const PEER_PILOT_ALLOWED_SOURCE = "personal-guide";
const PEER_PILOT_ALLOWED_PATH_PREFIX = "lesson/";

const TOOL_OPERATION_MAP: Record<string, string> = {
  personal_write: "write",
  personal_propose_capture: "propose",
};

/**
 * Extract source/path from bridge write-tool arguments (identical to gateway scope.ts).
 * personal_write → source/path; personal_propose_capture → suggested_source/suggested_path.
 * source has priority; hasConflict=true if both pairs present with different values — must
 * check the same key the backend reads, else suggested_* could smuggle a source past the gate.
 */
export function extractBridgeSourcePath(args: Record<string, unknown>): {
  source: string | undefined;
  path: string | undefined;
  hasConflict: boolean;
} {
  const src = typeof args.source === "string" ? args.source : undefined;
  const sugSrc = typeof args.suggested_source === "string" ? args.suggested_source : undefined;
  const pth = typeof args.path === "string" ? args.path : undefined;
  const sugPth = typeof args.suggested_path === "string" ? args.suggested_path : undefined;
  const hasConflict = (!!src && !!sugSrc && src !== sugSrc) || (!!pth && !!sugPth && pth !== sugPth);
  return { source: src ?? sugSrc, path: pth ?? sugPth, hasConflict };
}

export type ScopeDenyReason =
  | "scope_not_found"
  | "scope_revoked"
  | "scope_expired"
  | "operation_not_allowed"
  | "source_not_allowed"
  | "path_not_allowed"
  | "invalid_agent_id"
  | "indicators_db_unavailable";

// WP-410 Ф-scope fail-open (peer-session 2026-06-15-16): classify each ScopeDenyReason as an
// explicit scope-denial (block in enforce) or an infrastructure failure (fail open + alarm).
// Exhaustive Record — adding a new ScopeDenyReason forces a conscious deny/infra choice at
// compile time, so a new infra reason can never silently become a fail-closed SPOF (the 12 June
// class of incident), and a new real denial can never silently fail open.
const SCOPE_REASON_CLASS: Record<ScopeDenyReason, "deny" | "infra"> = {
  scope_not_found: "deny",
  scope_revoked: "deny",
  scope_expired: "deny",
  operation_not_allowed: "deny",
  source_not_allowed: "deny",
  path_not_allowed: "deny",
  invalid_agent_id: "deny",
  indicators_db_unavailable: "infra",
};

/**
 * Enforce-mode gate: block the write ONLY on an explicit scope-denial. Any infrastructure
 * failure (e.g. indicators_db_unavailable) or "ok" returns false → caller fails open with alarm.
 */
export function shouldBlockOnScope(reason: ScopeDenyReason | "ok"): boolean {
  return reason !== "ok" && SCOPE_REASON_CLASS[reason] === "deny";
}

export interface ScopeCheckResult {
  allow: boolean;
  /** Reason on deny; "ok" on allow — present for shadow-mode structured logging. */
  reason: ScopeDenyReason | "ok";
  denyResponse?: {
    code: number;
    message: string;
    data: {
      reason: ScopeDenyReason;
      attempted_tool: string;
      attempted_source?: string;
      attempted_path?: string;
    };
  };
}

interface BridgeScopeRow {
  allowed_repos: string[];
  allowed_paths: string[];
  allowed_operations: string[];
  taint_level: number;
}

export function normalizePath(input: string): string {
  let path = input.replace(/\\/g, "/");
  path = path.replace(/\/+/g, "/");
  path = path.replace(/^\/+/, "");
  const segments: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "..") {
      segments.pop();
    } else if (seg && seg !== ".") {
      segments.push(seg);
    }
  }
  return segments.join("/");
}

export function hasDotfileSegment(normalizedPath: string): boolean {
  return normalizedPath.split("/").some((seg) => seg.startsWith("."));
}

export function matchesGlob(path: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const PDS = "\x00DSS\x00";
  const PD = "\x00DS\x00";
  const PS = "\x00SS\x00";
  const tokenized = escaped
    .replace(/\*\*\//g, PDS)
    .replace(/\*\*/g, PD)
    .replace(/\*/g, PS);
  const regexBody = tokenized
    .split(PDS).join("(?:.*/)?")
    .split(PD).join(".*")
    .split(PS).join("[^/]*");
  return new RegExp(`^${regexBody}$`).test(path);
}

function matchesAnyGlob(path: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesGlob(path, p));
}

/**
 * Decide whether a bridge write-tool call is in-scope for the user.
 * Pure verdict — the caller decides whether to enforce (block) or shadow (log only).
 */
export async function checkBridgeWriteScope(opts: {
  toolName: string;                 // canonical: personal_write | personal_propose_capture
  source: string | undefined;
  path: string | undefined;
  hasConflict: boolean;
  userId: string;
  agentId: string | undefined;      // from _meta.agent_id
  requestId?: string;               // from _meta.request_id
  requireDeclaredAgentId?: boolean; // prod = true (mirrors bridge-scope server.ts:98)
  activeSources?: string[];         // user's active sources (UserContext.sourceNames)
  indicatorsSql: NeonSql;
}): Promise<ScopeCheckResult> {
  const {
    toolName, source, path, hasConflict,
    userId, agentId: declaredAgentId, requestId,
    requireDeclaredAgentId,
    activeSources,
    indicatorsSql,
  } = opts;

  if (!BRIDGE_WRITE_TOOLS.has(toolName)) {
    return { allow: true, reason: "ok" };
  }

  const expectedAgentId = `iwe_bridge:${toolName}`;
  let agentId = declaredAgentId ?? expectedAgentId;
  let isPeerPilotFallback = false;
  let isOwnDataWiden = false;

  if (requireDeclaredAgentId && (!declaredAgentId || declaredAgentId.length === 0)) {
    isPeerPilotFallback = true;
    agentId = PEER_PILOT_AGENT_ID;

    if (!path) {
      await tryInsertViolation({ indicatorsSql, agentId, userId, reason: "path_not_allowed", attemptedTool: toolName, attemptedRepo: source, requestId });
      return deny("scope denied: path required for peer-pilot helper", "path_not_allowed", toolName);
    }
    const safePath = normalizePath(path);

    if (hasDotfileSegment(safePath)) {
      await tryInsertViolation({ indicatorsSql, agentId, userId, reason: "path_not_allowed", attemptedTool: toolName, attemptedRepo: source, attemptedPath: safePath, requestId });
      return deny(`scope denied: path '${safePath}' targets a dotfile directory`, "path_not_allowed", toolName, undefined, safePath);
    }

    const isContinuationDefault =
      source === PEER_PILOT_ALLOWED_SOURCE &&
      safePath.startsWith(PEER_PILOT_ALLOWED_PATH_PREFIX);

    if (!isContinuationDefault) {
      const sources = activeSources ?? [];
      if (!source || !sources.includes(source)) {
        await tryInsertViolation({ indicatorsSql, agentId, userId, reason: "source_not_allowed", attemptedTool: toolName, attemptedRepo: source, attemptedPath: safePath, requestId });
        return deny(`scope denied: source '${source}' not allowed for peer-pilot helper`, "source_not_allowed", toolName, source);
      }
      isOwnDataWiden = true;
    }
  }

  if (!isPeerPilotFallback && agentId !== expectedAgentId) {
    await tryInsertViolation({ indicatorsSql, agentId, userId, reason: "invalid_agent_id", attemptedTool: toolName, requestId });
    return deny("scope denied: invalid agent_id", "invalid_agent_id", toolName);
  }

  if (hasConflict) {
    await tryInsertViolation({ indicatorsSql, agentId, userId, reason: "source_not_allowed", attemptedTool: toolName, attemptedRepo: source, requestId });
    return deny("scope denied: conflicting source/suggested_source in args", "source_not_allowed", toolName, source);
  }

  // DB lookup — single neon statement (no tx; RLS not forced, isolation via explicit WHERE).
  let scopeRow: BridgeScopeRow | null = null;
  let denyReason: ScopeDenyReason | null = null;

  try {
    const rows = (await indicatorsSql`
      SELECT allowed_repos, allowed_paths, allowed_operations, taint_level,
             revoked_at, expires_at
      FROM agent_scopes_mvp
      WHERE scope_kind = 'bridge'
        AND agent_id = ${agentId}
        AND user_id = ${userId}::uuid
    `) as Array<{
      allowed_repos: string[] | null;
      allowed_paths: string[] | null;
      allowed_operations: string[] | null;
      taint_level: number;
      revoked_at: string | null;
      expires_at: string | null;
    }>;

    if (rows.length === 0) {
      denyReason = "scope_not_found";
    } else {
      const row = rows[0];
      if (row.revoked_at !== null) {
        denyReason = "scope_revoked";
      } else if (row.expires_at !== null && new Date(row.expires_at).getTime() <= Date.now()) {
        denyReason = "scope_expired";
      } else {
        scopeRow = {
          allowed_repos: row.allowed_repos ?? [],
          allowed_paths: row.allowed_paths ?? [],
          allowed_operations: row.allowed_operations ?? [],
          taint_level: row.taint_level,
        };
      }
    }
  } catch {
    return deny("scope denied: indicators DB error", "indicators_db_unavailable", toolName);
  }

  if (denyReason !== null || scopeRow === null) {
    const reason = denyReason ?? "scope_not_found";
    await tryInsertViolation({ indicatorsSql, agentId, userId, reason, attemptedTool: toolName, requestId });
    return deny(`scope denied: ${reason}`, reason, toolName);
  }

  const operation = TOOL_OPERATION_MAP[toolName];
  if (!operation || !scopeRow.allowed_operations.includes(operation)) {
    await tryInsertViolation({ indicatorsSql, agentId, userId, reason: "operation_not_allowed", attemptedTool: toolName, requestId });
    return deny(`scope denied: operation '${operation}' not in allowed_operations`, "operation_not_allowed", toolName);
  }

  const safePath = path ? normalizePath(path) : undefined;

  if (!isOwnDataWiden && source && !scopeRow.allowed_repos.includes(source)) {
    await tryInsertViolation({ indicatorsSql, agentId, userId, reason: "source_not_allowed", attemptedTool: toolName, attemptedRepo: source, requestId });
    return deny(`scope denied: source '${source}' not allowed`, "source_not_allowed", toolName, source);
  }

  if (!isOwnDataWiden && safePath && scopeRow.allowed_paths.length > 0) {
    if (!matchesAnyGlob(safePath, scopeRow.allowed_paths)) {
      await tryInsertViolation({ indicatorsSql, agentId, userId, reason: "path_not_allowed", attemptedTool: toolName, attemptedRepo: source, attemptedPath: safePath, requestId });
      return deny(`scope denied: path '${safePath}' not in allowed_paths`, "path_not_allowed", toolName, source, safePath);
    }
  }

  return { allow: true, reason: "ok" };
}

// --- helpers ---

function deny(
  message: string,
  reason: ScopeDenyReason,
  toolName: string,
  source?: string,
  path?: string,
): ScopeCheckResult {
  return {
    allow: false,
    reason,
    denyResponse: {
      code: -32001,
      message,
      data: {
        reason,
        attempted_tool: toolName,
        ...(source !== undefined ? { attempted_source: source } : {}),
        ...(path !== undefined ? { attempted_path: path } : {}),
      },
    },
  };
}

interface InsertViolationOpts {
  indicatorsSql: NeonSql;
  agentId: string;
  userId: string;
  reason: ScopeDenyReason;
  attemptedTool: string;
  attemptedRepo?: string;
  attemptedPath?: string;
  requestId?: string;
}

async function tryInsertViolation(opts: InsertViolationOpts): Promise<void> {
  const safePath = opts.attemptedPath
    ? opts.attemptedPath.split("/").pop()?.slice(0, 100) ?? null
    : null;

  try {
    if (opts.requestId) {
      await opts.indicatorsSql`
        INSERT INTO agent_scope_violations
          (agent_id, user_id, attempted_repo, attempted_path, reason, request_id)
        VALUES (${opts.agentId}, ${opts.userId}::uuid, ${opts.attemptedRepo ?? null},
                ${safePath}, ${opts.reason}, ${opts.requestId}::uuid)
      `;
    } else {
      await opts.indicatorsSql`
        INSERT INTO agent_scope_violations
          (agent_id, user_id, attempted_repo, attempted_path, reason)
        VALUES (${opts.agentId}, ${opts.userId}::uuid, ${opts.attemptedRepo ?? null},
                ${safePath}, ${opts.reason})
      `;
    }
  } catch (err) {
    console.error(JSON.stringify({
      phase: "scope_violation_audit_fallback",
      severity: "warning",
      tag: "db_insert_failed",
      agent_id: opts.agentId,
      user_id_prefix: opts.userId.slice(0, 8),
      reason: opts.reason,
      attempted_tool: opts.attemptedTool,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * Provision the two bridge scope rows for a newly connected source. Idempotent upsert —
 * safe to call unconditionally on every connect so a revoked/lost scope row self-heals.
 * Ported from personal-knowledge-mcp/src/scope.ts:337-362 (peer-session 2026-07-01-27, срез-2b) — as-is.
 */
export async function provisionBridgeScopes(
  indicatorsSql: NeonSql,
  userId: string,
  source: string,
): Promise<void> {
  const allowedRepos = [source];
  await indicatorsSql`
    INSERT INTO agent_scopes_mvp
      (scope_kind, agent_id, user_id, allowed_repos, allowed_paths, allowed_operations, granted_by)
    VALUES
      ('bridge', 'iwe_bridge:personal_write',
       ${userId}::uuid, ${allowedRepos}::text[], ARRAY['docs/**','inbox/**','**/*.md'], ARRAY['write'], 'bridge_install'),
      ('bridge', 'iwe_bridge:personal_propose_capture',
       ${userId}::uuid, ${allowedRepos}::text[], ARRAY['inbox/**','**/*.md'], ARRAY['propose'], 'bridge_install')
    ON CONFLICT (agent_id, user_id) DO UPDATE SET
      allowed_repos = ARRAY(SELECT DISTINCT unnest(agent_scopes_mvp.allowed_repos || EXCLUDED.allowed_repos)),
      allowed_paths = EXCLUDED.allowed_paths,
      allowed_operations = EXCLUDED.allowed_operations,
      revoked_at = NULL
  `;
  console.log(JSON.stringify({
    phase: "bridge_scopes_provisioned",
    user_id: userId,
    source,
  }));
}
