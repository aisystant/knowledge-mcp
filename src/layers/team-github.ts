import { neon } from "@neondatabase/serverless";
import type { PersonalEnv } from "./personal.js";
import type { UserContext } from "./personal.js";

export interface TeamBinding {
  repositoryId: number;
  installationId: number;
  owner: string;
  repository: string;
  generation: number;
}

export function teamReposEnabled(env: PersonalEnv): boolean {
  return env.GITHUB_TEAM_REPOS_ENABLED === true || env.GITHUB_TEAM_REPOS_ENABLED === "true";
}

export function teamRepositoryName(source: string): { owner: string; repository: string } | null {
  const match = source.match(/^([A-Za-z\d](?:[A-Za-z\d-]{0,37}[A-Za-z\d])?)\/([A-Za-z\d._-]{1,100})$/);
  return match ? { owner: match[1], repository: match[2] } : null;
}

export async function activeTeamBinding(env: PersonalEnv, userId: string, source: string): Promise<TeamBinding | null> {
  const name = teamRepositoryName(source);
  if (!teamReposEnabled(env) || !env.DATABASE_URL || !name) return null;
  const sql = neon(env.DATABASE_URL);
  const [_, rows] = await sql.transaction([
    sql`SELECT set_config('app.user_id', ${userId}, true)`,
    sql`
      SELECT repository_id, installation_id, github_owner, github_repo, generation
      FROM knowledge.github_user_repo_bindings
      WHERE user_id = ${userId} AND active = true
        AND LOWER(github_owner) = ${name.owner.toLowerCase()}
        AND LOWER(github_repo) = ${name.repository.toLowerCase()}
    `,
  ]);
  if (rows.length !== 1) return null;
  const row = rows[0];
  const repositoryId = Number(row.repository_id);
  const installationId = Number(row.installation_id);
  const generation = Number(row.generation);
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0
    || !Number.isSafeInteger(installationId) || installationId <= 0
    || !Number.isSafeInteger(generation) || generation <= 0) return null;
  return { repositoryId, installationId, owner: String(row.github_owner), repository: String(row.github_repo), generation };
}

export interface TeamTokenLease {
  token: string;
  repositoryId: number;
  repository: string;
  visibility: "public" | "private" | "internal";
  generation: number;
  release(): Promise<boolean>;
}

export type TeamTokenDenial = "github_repository_permission_denied";

export async function issueTeamToken(
  env: PersonalEnv,
  userId: string,
  binding: TeamBinding,
  permission: "read" | "write",
  onDenied?: (reason: TeamTokenDenial) => void,
): Promise<TeamTokenLease | null> {
  if (!teamReposEnabled(env) || !env.GITHUB_INTEGRATION_URL || !env.GITHUB_BROKER_SHARED_SECRET) return null;
  const base = new URL(env.GITHUB_INTEGRATION_URL);
  if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") return null;
  const endpoint = new URL("/internal/github-user-token/issue", base);
  const response = await fetch(endpoint, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/json", "x-github-broker-secret": env.GITHUB_BROKER_SHARED_SECRET },
    body: JSON.stringify({ user_id: userId, repository_id: binding.repositoryId, permission }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    if (response.status === 403 && permission === "write") {
      const denial = await response.json().catch(() => null) as { error?: unknown } | null;
      if (denial?.error === "github_repository_permission_denied") {
        onDenied?.("github_repository_permission_denied");
      }
    }
    return null;
  }
  const data = await response.json() as {
    access_token?: unknown; repository_id?: unknown; repository?: unknown;
    visibility?: unknown; generation?: unknown;
  };
  const token = typeof data.access_token === "string" ? data.access_token : "";
  const release = async (): Promise<boolean> => {
    if (!token) return false;
    try {
      const revoked = await fetch(new URL("/internal/github-user-token/revoke", base), {
        method: "POST", redirect: "manual",
        headers: { "Content-Type": "application/json", "x-github-broker-secret": env.GITHUB_BROKER_SHARED_SECRET! },
        body: JSON.stringify({ access_token: token }),
        signal: AbortSignal.timeout(10_000),
      });
      return revoked.status === 204;
    } catch {
      return false;
    }
  };
  if (typeof data.access_token !== "string" || !data.access_token
    || Number(data.repository_id) !== binding.repositoryId
    || Number(data.generation) !== binding.generation
    || typeof data.repository !== "string"
    || !["public", "private", "internal"].includes(String(data.visibility))) {
    await release();
    return null;
  }
  const current = teamRepositoryName(data.repository);
  if (!current || current.owner.toLowerCase() !== binding.owner.toLowerCase()
    || current.repository.toLowerCase() !== binding.repository.toLowerCase()) {
    await release();
    return null;
  }
  return {
    token, repositoryId: binding.repositoryId,
    repository: data.repository, visibility: data.visibility as TeamTokenLease["visibility"],
    generation: binding.generation,
    release,
  };
}

/** Team sources never fall back to the installation token shared by the App. */
export async function repositoryToken(
  env: PersonalEnv,
  ctx: UserContext,
  source: string,
  permission: "read" | "write",
  legacyToken: () => Promise<string | null>,
  onDenied?: (reason: TeamTokenDenial) => void,
): Promise<{ token: string; repositoryId?: number; release(): Promise<void> } | null> {
  if (!source.includes("/")) {
    const token = await legacyToken();
    return token ? { token, release: async () => {} } : null;
  }
  if (!teamRepositoryName(source)) return null;
  if (!ctx.userId) return null;
  const binding = await activeTeamBinding(env, ctx.userId, source);
  if (!binding) return null;
  const lease = await issueTeamToken(env, ctx.userId, binding, permission, onDenied);
  if (!lease || lease.repository.toLowerCase() !== source.toLowerCase()) {
    if (lease) await lease.release();
    return null;
  }
  return { token: lease.token, repositoryId: lease.repositoryId, release: async () => { await lease.release(); } };
}

/** Enumerate current Markdown paths with a fresh per-user repository grant. */
export async function teamMarkdownFiles(
  env: PersonalEnv, ctx: UserContext, source: string,
): Promise<Array<{ path: string; size: number }>> {
  if (!source.includes("/") || !ctx.sources.some(s => s.source === source)) return [];
  const lease = await repositoryToken(env, ctx, source, "read", async () => null);
  if (!lease?.repositoryId) return [];
  try {
    return await enumerateTeamMarkdownFiles(source, lease.repositoryId, lease.token);
  } finally {
    await lease.release();
  }
}

/** List only a repository whose immutable ID was verified by the user's token lease. */
export async function enumerateTeamMarkdownFiles(
  source: string, repositoryId: number, token: string, githubFetch: typeof fetch = fetch,
): Promise<Array<{ path: string; size: number }>> {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
    "User-Agent": "aisystant-knowledge", "Cache-Control": "no-cache" };
  const base = `https://api.github.com/repos/${source.split("/").map(encodeURIComponent).join("/")}`;
  const get = async (url: string, stage: "metadata" | "default_branch" | "branches" | "tree",
    allowMissing = false): Promise<unknown | null> => {
    const response = await githubFetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) {
      // Do not log URLs, repository names, response bodies or credentials.
      console.warn(JSON.stringify({ event: "team_repository_listing_http_error", stage, status: response.status }));
      throw new Error("GitHub repository listing unavailable");
    }
    return response.json();
  };
  const metadata = await get(base, "metadata") as { id?: unknown; full_name?: unknown;
    default_branch?: unknown; size?: unknown; empty?: unknown };
  if (metadata.id !== repositoryId || typeof metadata.full_name !== "string"
    || metadata.full_name.toLowerCase() !== source.toLowerCase()) {
    throw new Error("GitHub repository identity changed");
  }
  const maybeEmpty = metadata.size === 0 || metadata.empty === true;
  const noBranches = async (): Promise<boolean> => {
    const branches = await get(`${base}/branches?per_page=1`, "branches");
    return Array.isArray(branches) && branches.length === 0;
  };
  if (!metadata.default_branch && maybeEmpty && await noBranches()) return [];
  if (typeof metadata.default_branch !== "string" || !metadata.default_branch) {
    throw new Error("GitHub default branch unavailable");
  }
  const branch = await get(`${base}/branches/${encodeURIComponent(metadata.default_branch)}`,
    "default_branch", maybeEmpty) as { commit?: { sha?: unknown } } | null;
  if (branch === null) {
    if (maybeEmpty && await noBranches()) return [];
    throw new Error("GitHub branch unavailable");
  }
  if (typeof branch.commit?.sha !== "string") throw new Error("GitHub branch unavailable");
  const tree = await get(`${base}/git/trees/${encodeURIComponent(branch.commit.sha)}?recursive=1`, "tree") as {
    tree?: unknown; truncated?: unknown;
  };
  if (!Array.isArray(tree.tree) || tree.truncated === true) throw new Error("GitHub tree incomplete");
  return tree.tree.filter((item: unknown): item is { type: "blob"; path: string; size: number } => {
    if (!item || typeof item !== "object") return false;
    const file = item as Record<string, unknown>;
    return file.type === "blob" && typeof file.path === "string" && file.path.endsWith(".md")
      && Number.isSafeInteger(file.size) && Number(file.size) >= 0;
  }).map(item => ({ path: item.path, size: item.size }));
}
