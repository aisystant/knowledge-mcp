/**
 * scope.ts — In-process scope enforcement for bridge write-tools (WP-410 срез-2b).
 * see DP.SC.165, ADR-IWE-019, ADR-mcp-unification-q1.
 *
 * Ported from personal-knowledge-mcp/src/scope.ts (peer-session 2026-07-01-21) as-is —
 * faithful port, no behavior change. That file itself was ported from
 * bridge-scope-service/src/scope.ts (which itself was ported from gateway).
 */

import { neon } from "@neondatabase/serverless";
import { normalizeRepositoryPath } from "./repository-path.js";

export { normalizeRepositoryPath as normalizePath } from "./repository-path.js";

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
const PEER_PILOT_ALLOWED_PATHS = ["docs/**", "inbox/**", "**/*.md"] as const;
const PEER_PILOT_ALLOWED_OPERATIONS = ["write", "propose"] as const;

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

interface StoredBridgeScopeRow {
  allowed_repos: string[] | null;
  allowed_paths: string[] | null;
  allowed_operations: string[] | null;
  taint_level: number;
  revoked_at: string | null;
  expires_at: string | null;
}

function activeBridgeScope(row: StoredBridgeScopeRow): BridgeScopeRow {
  return {
    allowed_repos: row.allowed_repos ?? [],
    allowed_paths: row.allowed_paths ?? [],
    allowed_operations: row.allowed_operations ?? [],
    taint_level: row.taint_level,
  };
}

export function hasDotfileSegment(normalizedPath: string): boolean {
  return normalizedPath.split("/").some((seg) => seg.startsWith("."));
}

export function matchesGlob(path: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
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
  // WP-410 Pre-Close checklist (session 2026-07-03-18): true for path-scoped ops (write/delete —
  // always carry a path). false for source-scoped admin ops (disconnect_source/purge_source,
  // reusing the personal_write canonical grant — their args carry no path by design). Default
  // true preserves prior behavior for the two BRIDGE_WRITE_TOOLS canonical names. Without this,
  // the peer-pilot fallback's `if (!path) deny` fires before the ownership check ever runs,
  // permanently denying disconnect/purge on the caller's OWN source for any client that doesn't
  // declare _meta.agent_id.
  requiresPath?: boolean;
}): Promise<ScopeCheckResult> {
  const {
    toolName, source, path, hasConflict,
    userId, agentId: declaredAgentId, requestId,
    requireDeclaredAgentId,
    activeSources,
    indicatorsSql,
    requiresPath = true,
  } = opts;

  if (!BRIDGE_WRITE_TOOLS.has(toolName)) {
    return { allow: true, reason: "ok" };
  }

  const expectedAgentId = `iwe_bridge:${toolName}`;
  let agentId = declaredAgentId ?? expectedAgentId;
  let safePath: string | undefined;
  try {
    safePath = requiresPath
      ? normalizeRepositoryPath(path ?? "")
      : path !== undefined ? normalizeRepositoryPath(path) : undefined;
  } catch {
    // Request syntax is rejected before scope lookup or audit writes. No stateful enforcement
    // work should run for a path that cannot identify one repository object unambiguously.
    return deny("scope denied: path must be a safe repository-relative path", "path_not_allowed", toolName, source);
  }
  let isPeerPilotFallback = false;
  let isOwnDataWiden = false;
  let isContinuationDefault = false;

  if (requireDeclaredAgentId && (!declaredAgentId || declaredAgentId.length === 0)) {
    isPeerPilotFallback = true;
    agentId = PEER_PILOT_AGENT_ID;

    if (safePath && hasDotfileSegment(safePath)) {
      await tryInsertViolation({ indicatorsSql, agentId, userId, reason: "path_not_allowed", attemptedTool: toolName, attemptedRepo: source, attemptedPath: safePath, requestId });
      return deny(`scope denied: path '${safePath}' targets a dotfile directory`, "path_not_allowed", toolName, undefined, safePath);
    }

    isContinuationDefault =
      !!safePath &&
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
    `) as StoredBridgeScopeRow[];

    if (rows.length === 0) {
      denyReason = "scope_not_found";
    } else {
      const row = rows[0];
      if (row.revoked_at !== null) {
        denyReason = "scope_revoked";
      } else if (row.expires_at !== null && new Date(row.expires_at).getTime() <= Date.now()) {
        denyReason = "scope_expired";
      } else {
        scopeRow = activeBridgeScope(row);
      }
    }
  } catch {
    return deny("scope denied: indicators DB error", "indicators_db_unavailable", toolName);
  }

  if (
    denyReason === "scope_not_found"
    && isPeerPilotFallback
    && (isOwnDataWiden || isContinuationDefault)
    && source
  ) {
    // A missing-agent fallback can repair only its own row, and only after the active-source
    // ownership check above. Explicit connect remains the sole path allowed to restore all
    // bridge identities or clear a revocation.
    try {
      const repairedScope = await provisionPeerPilotScope(indicatorsSql, userId, source);
      if (repairedScope) {
        scopeRow = repairedScope;
        denyReason = null;
      }
    } catch (err) {
      console.error(JSON.stringify({
        phase: "peer_pilot_self_heal_failed",
        severity: "error",
        user_id_prefix: userId.slice(0, 8),
        source,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  if (denyReason !== null || scopeRow === null) {
    const reason = denyReason ?? "scope_not_found";
    // attemptedRepo/attemptedPath were missing here before (WP-410 Pre-Close checklist, session
    // 2026-07-03-18) — every other deny call site in this file logs them; this one didn't,
    // leaving scope_not_found/scope_revoked/scope_expired violations impossible to diagnose from
    // agent_scope_violations alone (source/path always came back empty regardless of what was
    // actually attempted).
    await tryInsertViolation({ indicatorsSql, agentId, userId, reason, attemptedTool: toolName, attemptedRepo: source, attemptedPath: safePath, requestId });
    return deny(`scope denied: ${reason}`, reason, toolName);
  }

  const operation = TOOL_OPERATION_MAP[toolName];
  if (!operation || !scopeRow.allowed_operations.includes(operation)) {
    await tryInsertViolation({ indicatorsSql, agentId, userId, reason: "operation_not_allowed", attemptedTool: toolName, requestId });
    return deny(`scope denied: operation '${operation}' not in allowed_operations`, "operation_not_allowed", toolName);
  }

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

/**
 * Repair only the peer-pilot row after ownership has been proven. A revoked or expired row is
 * deliberately not revived: its conditional conflict update returns no row and the caller denies.
 */
async function provisionPeerPilotScope(
  indicatorsSql: NeonSql,
  userId: string,
  source: string,
): Promise<BridgeScopeRow | null> {
  const allowedRepos = [source];
  const allowedPaths = [...PEER_PILOT_ALLOWED_PATHS];
  const allowedOperations = [...PEER_PILOT_ALLOWED_OPERATIONS];
  const rows = (await indicatorsSql`
    INSERT INTO agent_scopes_mvp
      (scope_kind, agent_id, user_id, allowed_repos, allowed_paths, allowed_operations, granted_by)
    VALUES
      ('bridge', ${PEER_PILOT_AGENT_ID},
       ${userId}::uuid, ${allowedRepos}::text[], ${allowedPaths}::text[], ${allowedOperations}::text[], 'bridge_install')
    ON CONFLICT (agent_id, user_id) DO UPDATE SET
      allowed_repos = ARRAY(SELECT DISTINCT unnest(agent_scopes_mvp.allowed_repos || EXCLUDED.allowed_repos)),
      allowed_paths = EXCLUDED.allowed_paths,
      allowed_operations = EXCLUDED.allowed_operations
    WHERE agent_scopes_mvp.revoked_at IS NULL
      AND (agent_scopes_mvp.expires_at IS NULL OR agent_scopes_mvp.expires_at > NOW())
    RETURNING allowed_repos, allowed_paths, allowed_operations, taint_level, revoked_at, expires_at
  `) as StoredBridgeScopeRow[];

  return rows.length > 0 ? activeBridgeScope(rows[0]) : null;
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
 * Provision the bridge scope rows for a newly connected source: the two declared-agent rows
 * plus the peer-pilot fallback row. Idempotent upsert — safe to call unconditionally on every
 * connect so a revoked/lost scope row self-heals.
 *
 * WP-410 Pre-Close checklist (session 2026-07-03-18): the fallback row (third VALUES tuple,
 * agent_id = PEER_PILOT_AGENT_ID) was missing from this port — restored from
 * personal-knowledge-mcp/src/scope.ts:373-399 (which itself documents WHY: "without the fallback
 * row, any caller that omits _meta.agent_id ... hits scope_not_found forever regardless of how
 * many times a source is (re)connected"). Without it, checkBridgeWriteScope's own self-heal
 * branch (above) can never converge — it looks up `WHERE agent_id = PEER_PILOT_AGENT_ID`, but
 * this function was only ever writing the two `iwe_bridge:*` rows, so every fallback-identity
 * call re-provisions from scratch instead of finding the row from its own prior write (cold-review
 * finding, not a security hole — the ownership gate still re-runs correctly each time, this was a
 * "silently never converges" bug, not a privilege issue).
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
       ${userId}::uuid, ${allowedRepos}::text[], ARRAY['inbox/**','**/*.md'], ARRAY['propose'], 'bridge_install'),
      ('bridge', ${PEER_PILOT_AGENT_ID},
       ${userId}::uuid, ${allowedRepos}::text[], ARRAY['docs/**','inbox/**','**/*.md'], ARRAY['write','propose'], 'bridge_install')
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
