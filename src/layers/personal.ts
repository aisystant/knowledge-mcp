// Personal-corpus data layer for the private MCP mode (WP-410 срез-2b).
// Ported from personal-knowledge-mcp/src/index.ts, then hardened in this private-mode layer:
// resolveUserContext, GitHub App JWT signing, writeToGitHub, getInstallationToken.
//
// Talks to the personal Neon DB (env.DATABASE_URL) via plain neon() + explicit `WHERE user_id`
// (NOT the RLS/withUserContext machinery in ../rls.ts — that machinery is scoped to the
// knowledge DB's own RLS migrations, which do not exist for user_sources on the personal DB;
// see security-gate-b73-private-port.md §2, "не RLS — подтверждено 2026-06-11, relrowsecurity=f").

import { neon } from "@neondatabase/serverless";
import { getKnowledgeSchema, KNOWLEDGE_TABLES } from "../utils/db.js";
import { provisionBridgeScopes } from "../scope.js";
import {
  githubBlobUrl,
  githubContentsApiUrl,
  normalizeRepositoryPath,
  resolveSourcePath,
} from "../repository-path.js";

export {
  encodeGitHubContentsPath,
  githubBlobUrl,
  githubBranchApiUrl,
  githubContentsApiUrl,
  normalizeRepositoryPath,
  resolveSourcePath,
} from "../repository-path.js";

export interface PersonalEnv {
  // Optional at the Env-interface level (only bound when MCP_MODE=private) — required at
  // call time; personalDb() throws a clear error rather than passing undefined to neon().
  DATABASE_URL?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  KNOWLEDGE_DB_SCHEMA?: string;
  OPENROUTER_API_KEY?: string;
  /** Neon `indicators` DB. Required for provisionBridgeScopes (connect_source) — same DSN as PrivateGuard's authorize(). */
  INDICATORS_DATABASE_URL?: string;
  /** Watchdog stale-job threshold override, minutes. Default 30 (see reindex.ts). Деплой-2 группа В. */
  WATCHDOG_STALE_MINUTES?: string;
}

export interface UserSource {
  source: string;
  githubOwner: string;
  githubRepo: string;
  pathPrefix: string;
  sourceType: string;
}

export interface UserContext {
  userId: string | null;
  sources: UserSource[];
  sourceNames: string[];
}

const MANAGED_KNOWLEDGE_INDEX_OWNER = "tserentserenov";
const MANAGED_KNOWLEDGE_INDEX_REPO = "ds-knowledge-index-tseren";
const GIT_BLOB_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const POST_CHANNEL_FILENAME = /^(?:(?:\d{2}-\d{2})|\d{1,4})-\d{1,2}-(?:club|facebook|linkedin|telegram|tenchat|x|youtube|dzen|habr)-\d{4}-\d{2}-\d{2}\.md$/i;

export const POST_SCAFFOLD_REQUIRED_MESSAGE =
  "Создание публикации через personal_write заблокировано: номер и канонический путь назначает scripts/new-post.py.";
export const POST_SCAFFOLD_NEXT_ACTION =
  "Из корня DS-Knowledge-Index-Tseren запусти `python3 scripts/new-post.py --date YYYY-MM-DD --slug <slug> " +
  "--title \"<title>\" --channels <channels>`. Если shell или скрипт недоступны, остановись и сообщи о блокере; " +
  "ASCII/manual fallback и ручное создание файла запрещены.";
export const EXISTENCE_CHECK_UNAVAILABLE_MESSAGE =
  "Не удалось надёжно определить, существует ли целевой файл в GitHub; запись остановлена без PUT.";
export const EXISTENCE_CHECK_NEXT_ACTION =
  "Повтори personal_write после восстановления проверки GitHub. Для публикации не используй ручной или ASCII fallback.";

export type ManagedPostEvidence = "frontmatter_type_post" | "channel_filename";

export interface PersonalWriteResult {
  success: boolean;
  sha?: string;
  url?: string;
  error?: string;
  reason?: "post_scaffold_required" | "existence_check_unavailable";
  next_action?: string;
  evidence?: ManagedPostEvidence;
}

function frontmatterDeclaresPost(content: string): boolean {
  const lines = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return false;

  const closingBoundary = lines.findIndex(
    (line, index) => index > 0 && (line.trim() === "---" || line.trim() === "..."),
  );
  if (closingBoundary === -1) return false;

  return lines
    .slice(1, closingBoundary)
    .some(line => /^type\s*:\s*(["']?)post\1\s*(?:#.*)?$/i.test(line.trim()));
}

/** Return explicit publication evidence, or null for ordinary/service Markdown. */
export function getManagedKnowledgeIndexPostEvidence(
  target: Pick<UserSource, "githubOwner" | "githubRepo">,
  path: string,
  content: string,
): ManagedPostEvidence | null {
  const isManagedRepo = target.githubOwner.toLowerCase() === MANAGED_KNOWLEDGE_INDEX_OWNER
    && target.githubRepo.toLowerCase() === MANAGED_KNOWLEDGE_INDEX_REPO;
  const normalizedPath = normalizeRepositoryPath(path);
  if (!isManagedRepo || !normalizedPath.startsWith("docs/")) return null;

  const filename = normalizedPath.split("/").at(-1) ?? "";
  if (frontmatterDeclaresPost(content)) return "frontmatter_type_post";
  return POST_CHANNEL_FILENAME.test(filename) ? "channel_filename" : null;
}

// Exported for reuse by ./reindex.ts (WP-410 Деплой-2 группа Б) — same personal Neon DB.
export function personalDb(env: PersonalEnv) {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for private-mode personal data access");
  }
  return neon(env.DATABASE_URL);
}

export async function resolveUserContext(env: PersonalEnv, userId: string | null): Promise<UserContext> {
  if (userId) {
    try {
      const sql = personalDb(env);
      const schema = getKnowledgeSchema(env);
      const userSourcesTable = KNOWLEDGE_TABLES.user_sources(schema);
      const rows = await sql`
        SELECT source, github_owner, github_repo, path_prefix, source_type
        FROM ${sql.unsafe(userSourcesTable)}
        WHERE user_id = ${userId} AND active = true
        ORDER BY source
      `;
      if (rows.length > 0) {
        const sources = rows.map(r => ({
          source: r.source as string,
          githubOwner: r.github_owner as string,
          githubRepo: r.github_repo as string,
          pathPrefix: (r.path_prefix as string) || "",
          sourceType: (r.source_type as string) || "ds",
        }));
        return {
          userId,
          sources,
          sourceNames: sources.map(s => s.source),
        };
      }
    } catch (err) {
      console.error(`resolveUserContext: DB error for user ${userId}, falling back to defaults:`, err instanceof Error ? err.message : err);
    }
  }

  // No sources found — return empty context (never leak other users' data)
  console.warn(`resolveUserContext: no sources for user ${userId ?? "(anonymous)"} — returning empty context`);
  return { userId, sources: [], sourceNames: [] };
}

// --- GitHub App auth (Installation Token via App JWT) ---

async function importGitHubAppPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  // Normalize literal "\n" (common `wrangler secret put | echo` pitfall) into real newlines.
  const normalized = privateKeyPem.replace(/\\n/g, "\n");
  const pkcs8Match = normalized.match(/-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/);
  const pkcs1Match = normalized.match(/-----BEGIN RSA PRIVATE KEY-----([\s\S]*?)-----END RSA PRIVATE KEY-----/);

  let derBytes: Uint8Array;
  if (pkcs8Match) {
    const b64 = pkcs8Match[1].replace(/\s/g, "");
    derBytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } else if (pkcs1Match) {
    const b64 = pkcs1Match[1].replace(/\s/g, "");
    const pkcs1Der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    derBytes = wrapPkcs1InPkcs8(pkcs1Der);
  } else {
    throw new Error("GITHUB_APP_PRIVATE_KEY: PEM header is neither 'PRIVATE KEY' (PKCS#8) nor 'RSA PRIVATE KEY' (PKCS#1).");
  }

  // `as BufferSource`: TS's Uint8Array<ArrayBufferLike> (post-5.7 lib) includes a SharedArrayBuffer
  // branch that importKey's BufferSource overload rejects; derBytes is always a fresh, non-shared
  // buffer here (Uint8Array.from / manual byte array above), so the branch never applies at runtime.
  return crypto.subtle.importKey("pkcs8", derBytes as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

/**
 * Wrap a PKCS#1 RSAPrivateKey DER blob in a PKCS#8 SubjectPrivateKeyInfo envelope
 * with rsaEncryption (1.2.840.113549.1.1.1) algorithm identifier.
 */
function wrapPkcs1InPkcs8(pkcs1Der: Uint8Array): Uint8Array {
  const rsaOid = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
  const algId = [0x30, 0x0d, ...rsaOid, 0x05, 0x00];
  const version = [0x02, 0x01, 0x00];

  const encodeLen = (n: number): number[] => {
    if (n < 0x80) return [n];
    if (n < 0x100) return [0x81, n];
    return [0x82, (n >> 8) & 0xff, n & 0xff];
  };

  const octetHeader = [0x04, ...encodeLen(pkcs1Der.length)];
  const inner = [...version, ...algId, ...octetHeader, ...pkcs1Der];
  const outer = [0x30, ...encodeLen(inner.length), ...inner];
  return new Uint8Array(outer);
}

/**
 * Create a JWT signed with GitHub App private key.
 * Used to get Installation Access Tokens.
 */
async function createGitHubAppJWT(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 600, iss: appId };

  const enc = (obj: unknown) => btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const headerB64 = enc(header);
  const payloadB64 = enc(payload);
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importGitHubAppPrivateKey(privateKeyPem);

  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  return `${signingInput}.${sigB64}`;
}

/**
 * Get Installation Access Token for a specific repo owner.
 */
// Exported for reuse by ./reindex.ts (WP-410 Деплой-2 группа Б) — same GitHub App auth.
export async function getInstallationToken(env: PersonalEnv, owner: string): Promise<string | null> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) return null;

  const jwt = await createGitHubAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);

  // Find installation for this owner
  const installationsResp = await fetch("https://api.github.com/app/installations", {
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": "aisystant-knowledge" },
  });

  if (!installationsResp.ok) return null;

  const installations = (await installationsResp.json()) as { id: number; account: { login: string } }[];
  const installation = installations.find((i) => i.account.login.toLowerCase() === owner.toLowerCase());
  if (!installation) return null;

  // Get access token for this installation
  const tokenResp = await fetch(`https://api.github.com/app/installations/${installation.id}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": "aisystant-knowledge" },
  });

  if (!tokenResp.ok) return null;

  const tokenData = (await tokenResp.json()) as { token: string };
  return tokenData.token;
}

export interface GitHubApiDependencies {
  getInstallationToken: typeof getInstallationToken;
  fetch: typeof globalThis.fetch;
}

type GitHubFileExistence =
  | { state: "exists"; sha: string }
  | { state: "missing" }
  | { state: "unavailable" };

async function checkGitHubFileExistence(
  githubFetch: typeof globalThis.fetch,
  apiUrl: string,
  token: string,
): Promise<GitHubFileExistence> {
  let response: Response;
  try {
    response = await githubFetch(apiUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "aisystant-knowledge" },
    });
  } catch {
    return { state: "unavailable" };
  }

  if (response.status === 404) return { state: "missing" };
  if (!response.ok) return { state: "unavailable" };

  try {
    const existing = (await response.json()) as { sha?: unknown };
    if (typeof existing.sha !== "string" || !GIT_BLOB_SHA.test(existing.sha)) {
      return { state: "unavailable" };
    }
    return { state: "exists", sha: existing.sha };
  } catch {
    return { state: "unavailable" };
  }
}

function postScaffoldRequired(evidence: ManagedPostEvidence): PersonalWriteResult {
  return {
    success: false,
    reason: "post_scaffold_required",
    evidence,
    error: POST_SCAFFOLD_REQUIRED_MESSAGE,
    next_action: POST_SCAFFOLD_NEXT_ACTION,
  };
}

function existenceCheckUnavailable(): PersonalWriteResult {
  return {
    success: false,
    reason: "existence_check_unavailable",
    error: EXISTENCE_CHECK_UNAVAILABLE_MESSAGE,
    next_action: EXISTENCE_CHECK_NEXT_ACTION,
  };
}

/**
 * Write a file to GitHub repo using Installation Token.
 */
export async function writeToGitHub(
  env: PersonalEnv,
  ctx: UserContext,
  source: string,
  path: string,
  content: string,
  message: string,
  dependencies: Partial<GitHubApiDependencies> = {},
): Promise<PersonalWriteResult> {
  const userSource = ctx.sources.find(s => s.source === source);
  if (!userSource) return { success: false, error: `Unknown source: ${source}` };

  let fullPath: string;
  try {
    fullPath = resolveSourcePath(userSource.pathPrefix, path).fullPath;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Invalid repository path" };
  }

  const postEvidence = getManagedKnowledgeIndexPostEvidence(userSource, fullPath, content);

  const owner = userSource.githubOwner;
  const repo = userSource.githubRepo;
  const getToken = dependencies.getInstallationToken ?? getInstallationToken;
  const githubFetch = dependencies.fetch ?? globalThis.fetch;
  const token = await getToken(env, owner);
  if (!token) return { success: false, error: `No GitHub App installation found for ${owner}. Install the app: https://github.com/apps/aisystant-knowledge` };

  const apiUrl = githubContentsApiUrl(owner, repo, fullPath);
  const existence = await checkGitHubFileExistence(githubFetch, apiUrl, token);
  if (existence.state === "unavailable") return existenceCheckUnavailable();
  if (existence.state === "missing" && postEvidence) return postScaffoldRequired(postEvidence);
  const existingSha = existence.state === "exists" ? existence.sha : undefined;

  // Create or update file
  const putResp = await githubFetch(apiUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "aisystant-knowledge", "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: btoa(unescape(encodeURIComponent(content))),
      ...(existingSha ? { sha: existingSha } : {}),
    }),
  });

  if (!putResp.ok) {
    const err = await putResp.text();
    return { success: false, error: `GitHub API error ${putResp.status}: ${err}` };
  }

  const result = (await putResp.json()) as { content: { sha: string; html_url: string } };
  return { success: true, sha: result.content.sha, url: result.content.html_url };
}

/**
 * Delete a file from GitHub repo using Installation Token, and drop its index rows.
 * Faithful port of personal-knowledge-mcp/src/index.ts:749-~800 (deleteFromGitHub).
 */
export async function deleteFromGitHub(
  env: PersonalEnv,
  ctx: UserContext,
  source: string,
  path: string,
  message: string,
  dependencies: Partial<GitHubApiDependencies> = {},
): Promise<{ success: boolean; error?: string }> {
  const userSource = ctx.sources.find(s => s.source === source);
  if (!userSource) return { success: false, error: `Unknown source: ${source}` };

  let normalizedPath: string;
  let fullPath: string;
  try {
    const resolvedPath = resolveSourcePath(userSource.pathPrefix, path);
    normalizedPath = resolvedPath.relativePath;
    fullPath = resolvedPath.fullPath;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Invalid repository path" };
  }

  const owner = userSource.githubOwner;
  const repo = userSource.githubRepo;
  const getToken = dependencies.getInstallationToken ?? getInstallationToken;
  const githubFetch = dependencies.fetch ?? globalThis.fetch;
  const token = await getToken(env, owner);
  if (!token) return { success: false, error: `No GitHub App installation found for ${owner}. Install the app: https://github.com/apps/aisystant-knowledge` };

  const apiUrl = githubContentsApiUrl(owner, repo, fullPath);

  const getResp = await githubFetch(apiUrl, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "aisystant-knowledge" },
  });
  if (!getResp.ok) {
    return { success: false, error: `File not found: ${path} in ${source}` };
  }
  const existing = (await getResp.json()) as { sha: string };

  const delResp = await githubFetch(apiUrl, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "aisystant-knowledge", "Content-Type": "application/json" },
    body: JSON.stringify({ message, sha: existing.sha }),
  });

  if (!delResp.ok) {
    const err = await delResp.text();
    return { success: false, error: `GitHub API error ${delResp.status}: ${err}` };
  }

  if (!ctx.userId) {
    return { success: false, error: "Invalid user context: missing userId" };
  }
  const sql = personalDb(env);
  const schema = getKnowledgeSchema(env);
  const documentsTable = KNOWLEDGE_TABLES.documents(schema);
  const chunkPrefix = `${normalizedPath}::`;
  await sql`
    DELETE FROM ${sql.unsafe(documentsTable)}
    WHERE user_id = ${ctx.userId} AND source = ${source}
      AND (filename = ${normalizedPath}
        OR left(filename, char_length(${chunkPrefix})) = ${chunkPrefix})
  `;

  return { success: true };
}

// --- Personal search / read (WP-410 срез-2b, dual-mode private branch) ---
// Faithful port of personal-knowledge-mcp/src/index.ts:176-585 (resolveGithubUrl, getEmbedding,
// detectQueryType, keywordSearch, vectorSearch, searchDocuments, memorySearch, getDocument,
// listSources) — reads env.DATABASE_URL (personal Neon DB), NOT env.KNOWLEDGE_DATABASE_URL
// (public corpus, untouched by this file). No behavior change from the source.

const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const VECTOR_CONFIDENCE_THRESHOLD = 0.6;
const OPENAI_MAX_ATTEMPTS = 4;
const OPENAI_BASE_DELAY_MS = 500;
const OPENAI_MAX_DELAY_MS = 10_000;

export type PersonalSearchResult = {
  filename: string;
  content: string;
  source: string;
  source_type: string;
  score: number;
  github_url: string | null;
};
export type PersonalMemorySearchResult = PersonalSearchResult & { updated_at: string; age_days: number };

function personalGithubUrl(ctx: UserContext, source: string, filename: string): string | null {
  const userSource = ctx.sources.find(s => s.source === source);
  if (!userSource) return null;
  const cleanFilename = filename.split("::")[0];
  try {
    const fullPath = resolveSourcePath(userSource.pathPrefix, cleanFilename).fullPath;
    return githubBlobUrl(userSource.githubOwner, userSource.githubRepo, fullPath);
  } catch {
    return null;
  }
}

// Exported for reuse by ./reindex.ts (WP-410 Деплой-2 группа Б) — same embedding call.
export async function personalGetEmbedding(apiKey: string, text: string): Promise<number[]> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= OPENAI_MAX_ATTEMPTS; attempt++) {
    const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: [text], model: EMBEDDING_MODEL, dimensions: 1024 }),
    });

    if (response.ok) {
      const data = (await response.json()) as { data: { embedding: number[] }[] };
      return data.data[0].embedding;
    }

    const errText = await response.text();
    const isRetryable = response.status >= 500 || response.status === 429;
    if (!isRetryable || attempt === OPENAI_MAX_ATTEMPTS) {
      throw new Error(`OpenAI Embeddings error: ${response.status} ${errText}`);
    }

    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : 0;
    const backoffMs = OPENAI_BASE_DELAY_MS * Math.pow(2, attempt - 1);
    const delay = Math.min(Math.max(retryAfterMs, backoffMs), OPENAI_MAX_DELAY_MS);
    lastErr = new Error(`OpenAI ${response.status}: ${errText.slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, delay));
  }
  throw lastErr instanceof Error ? lastErr : new Error("OpenAI Embeddings retry exhausted");
}

type PersonalQueryType = "keyword" | "vector";

export function detectPersonalQueryType(query: string): PersonalQueryType {
  if (/[A-Z]{2,}\.\w+\.\d+/.test(query)) return "keyword";
  if (query.length < 30 && /\.[A-Z]/.test(query)) return "keyword";
  return "vector";
}

async function personalKeywordSearch(
  env: PersonalEnv,
  ctx: UserContext,
  query: string,
  source: string | undefined,
  limit: number
): Promise<PersonalSearchResult[]> {
  const sql = personalDb(env);
  const schema = getKnowledgeSchema(env);
  const documentsTable = KNOWLEDGE_TABLES.documents(schema);
  const src = source ?? null;
  const pattern = `%${query}%`;
  const ftsQuery = query.replace(/-/g, " ");
  const sourceNames = ctx.sourceNames;

  const entityMatch = query.match(/[A-Z]{2,}\.\w+\.\d+/);
  const entityPattern = entityMatch ? `%${entityMatch[0]}%` : null;
  const sectionRest = entityMatch ? query.replace(entityMatch[0], "").replace(/[§#]/g, "").trim() : null;
  const sectionPattern = sectionRest ? `%${sectionRest}%` : null;

  const rows = await sql`
    SELECT filename, content, source, source_type,
           CASE
             WHEN filename ILIKE ${pattern} THEN 1.0
             WHEN ${entityPattern}::text IS NOT NULL
                  AND filename ILIKE ${entityPattern}
                  AND ${sectionPattern}::text IS NOT NULL
                  AND content ILIKE ${sectionPattern} THEN 0.98
             WHEN filename ILIKE ${entityPattern} AND ${entityPattern}::text IS NOT NULL THEN 0.95
             WHEN content ILIKE ${pattern} THEN 0.90
             WHEN search_vector @@ plainto_tsquery('simple', ${ftsQuery}) THEN 0.8
             ELSE 0.5
           END AS score
    FROM ${sql.unsafe(documentsTable)}
    WHERE (content ILIKE ${pattern}
           OR filename ILIKE ${pattern}
           OR search_vector @@ plainto_tsquery('simple', ${ftsQuery})
           OR (${entityPattern}::text IS NOT NULL AND filename ILIKE ${entityPattern}))
      AND user_id = ${ctx.userId}
      AND source = ANY(${sourceNames})
      AND (${src}::text IS NULL OR source = ${src})
    ORDER BY score DESC,
             CASE WHEN filename ILIKE ${pattern} THEN 0 ELSE 1 END,
             length(content) DESC
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    filename: r.filename as string,
    content: r.content as string,
    source: (r.source as string) || "",
    source_type: (r.source_type as string) || "",
    score: r.score as number,
    github_url: personalGithubUrl(ctx, (r.source as string) || "", r.filename as string),
  }));
}

async function personalVectorSearch(
  env: PersonalEnv,
  ctx: UserContext,
  query: string,
  source: string | undefined,
  limit: number
): Promise<PersonalSearchResult[]> {
  const embedding = await personalGetEmbedding(env.OPENROUTER_API_KEY ?? "", query);
  const vec = `[${embedding.join(",")}]`;
  const sql = personalDb(env);
  const schema = getKnowledgeSchema(env);
  const documentsTable = KNOWLEDGE_TABLES.documents(schema);
  const src = source ?? null;
  const sourceNames = ctx.sourceNames;

  const rows = await sql`
    SELECT filename, content, source, source_type,
           1 - (embedding <=> ${vec}::vector) AS score
    FROM ${sql.unsafe(documentsTable)}
    WHERE user_id = ${ctx.userId}
      AND source = ANY(${sourceNames})
      AND (${src}::text IS NULL OR source = ${src})
    ORDER BY embedding <=> ${vec}::vector
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    filename: r.filename as string,
    content: r.content as string,
    source: (r.source as string) || "",
    source_type: (r.source_type as string) || "",
    score: r.score as number,
    github_url: personalGithubUrl(ctx, (r.source as string) || "", r.filename as string),
  }));
}

/** Private-mode `search`: personal corpus only (env.DATABASE_URL), scoped to ctx.sourceNames. */
export async function personalSearchDocuments(
  env: PersonalEnv,
  ctx: UserContext,
  query: string,
  source: string | undefined,
  limit: number = 5
): Promise<PersonalSearchResult[]> {
  const queryType = detectPersonalQueryType(query);

  if (queryType === "keyword") {
    const kwResults = await personalKeywordSearch(env, ctx, query, source, limit);
    if (kwResults.length > 0) return kwResults;
  }

  const vectorResults = await personalVectorSearch(env, ctx, query, source, limit);

  if (vectorResults.length > 0 && vectorResults[0].score < VECTOR_CONFIDENCE_THRESHOLD) {
    const kwFallback = await personalKeywordSearch(env, ctx, query, source, limit);
    if (kwFallback.length > 0) {
      const seen = new Map<string, PersonalSearchResult>();
      for (const r of [...kwFallback, ...vectorResults]) {
        const existing = seen.get(r.filename);
        if (!existing || r.score > existing.score) seen.set(r.filename, r);
      }
      return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    }
  }

  return vectorResults;
}

/** Private-mode `memory_search`: recency-weighted personal search. No public equivalent. */
export async function personalMemorySearch(
  env: PersonalEnv,
  ctx: UserContext,
  query: string,
  recencyDays: number | undefined,
  limit: number = 5
): Promise<PersonalMemorySearchResult[]> {
  const embedding = await personalGetEmbedding(env.OPENROUTER_API_KEY ?? "", query);
  const vec = `[${embedding.join(",")}]`;
  const sql = personalDb(env);
  const schema = getKnowledgeSchema(env);
  const documentsTable = KNOWLEDGE_TABLES.documents(schema);
  const sourceNames = ctx.sourceNames;
  const cutoff = recencyDays ? new Date(Date.now() - recencyDays * 24 * 60 * 60 * 1000).toISOString() : null;

  const rows = await sql`
    SELECT filename, content, source, source_type, updated_at,
           1 - (embedding <=> ${vec}::vector) AS base_score
    FROM ${sql.unsafe(documentsTable)}
    WHERE user_id = ${ctx.userId}
      AND source = ANY(${sourceNames})
      AND (${cutoff}::timestamptz IS NULL OR updated_at >= ${cutoff}::timestamptz)
    ORDER BY embedding <=> ${vec}::vector
    LIMIT ${limit * 3}
  `;

  const now = Date.now();
  return rows
    .map((r) => {
      const ageDays = (now - new Date(r.updated_at as string).getTime()) / (1000 * 60 * 60 * 24);
      const decayFactor = ageDays <= 14 ? 1.0 : ageDays <= 30 ? 0.7 : 0.4;
      return {
        filename: r.filename as string,
        content: r.content as string,
        source: (r.source as string) || "",
        source_type: (r.source_type as string) || "",
        score: (r.base_score as number) * decayFactor,
        github_url: personalGithubUrl(ctx, (r.source as string) || "", r.filename as string),
        updated_at: r.updated_at as string,
        age_days: Math.round(ageDays),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Private-mode `get_document`: personal corpus only. */
export async function personalGetDocument(
  env: PersonalEnv,
  ctx: UserContext,
  filename: string,
  source?: string
): Promise<{ filename: string; content: string; source: string; source_type: string; github_url: string | null } | null> {
  const separatorIndex = filename.indexOf("::");
  const requestedBaseName = separatorIndex === -1 ? filename : filename.slice(0, separatorIndex);
  let baseName: string;
  try {
    baseName = normalizeRepositoryPath(requestedBaseName);
  } catch {
    return null;
  }
  const normalizedFilename = separatorIndex === -1 ? baseName : `${baseName}${filename.slice(separatorIndex)}`;

  const sql = personalDb(env);
  const schema = getKnowledgeSchema(env);
  const documentsTable = KNOWLEDGE_TABLES.documents(schema);
  const src = source ?? null;
  const sourceNames = ctx.sourceNames;
  const chunkPrefix = `${baseName}::`;

  const rows = await sql`
    SELECT filename, content, source, source_type
    FROM ${sql.unsafe(documentsTable)}
    WHERE (filename = ${normalizedFilename}
           OR left(filename, char_length(${chunkPrefix})) = ${chunkPrefix})
      AND user_id = ${ctx.userId}
      AND source = ANY(${sourceNames})
      AND (${src}::text IS NULL OR source = ${src})
    ORDER BY
      CASE WHEN filename = ${normalizedFilename} THEN 0 ELSE 1 END,
      filename
    LIMIT 1
  `;

  if (!rows.length) return null;
  const r = rows[0];
  return {
    filename: r.filename as string,
    content: r.content as string,
    source: (r.source as string) || "",
    source_type: (r.source_type as string) || "",
    github_url: personalGithubUrl(ctx, (r.source as string) || "", r.filename as string),
  };
}

/** Private-mode `list_sources`: personal corpus only. */
export async function personalListSources(
  env: PersonalEnv,
  ctx: UserContext
): Promise<{ source: string; source_type: string; doc_count: number }[]> {
  const sql = personalDb(env);
  const sourceNames = ctx.sourceNames;
  const docsTable = KNOWLEDGE_TABLES.documents(getKnowledgeSchema(env));

  const rows = await sql`
    SELECT source, source_type, COUNT(*)::int AS doc_count
    FROM ${sql.unsafe(docsTable)}
    WHERE user_id = ${ctx.userId}
      AND source = ANY(${sourceNames})
    GROUP BY source, source_type
    ORDER BY source_type, source
  `;

  return rows.map((r) => ({
    source: (r.source as string) || "",
    source_type: (r.source_type as string) || "",
    doc_count: r.doc_count as number,
  }));
}

// --- connect_source (WP-410 срез-2b) ---
// Faithful port of personal-knowledge-mcp/src/index.ts:2704-~2793 (connectSource). The reindex
// trigger (Step 3 of the original) is wired by the caller (../index.ts), not here — startReindexJob
// lives in ./reindex.js, which itself imports from this module, so calling it from here would be
// a circular import. connectSource() only reports scope-provisioning outcome; ../index.ts calls
// startReindexJob() right after when scope_provisioning === "ok" and fills in reindex_triggered.
// provisionBridgeScopes (Step 2 of the original) is done in-process here — the reason connect_source
// is in Деплой-1 at all (WP-410 explicit requirement).
export interface ConnectSourceResult {
  source: string;
  status: "newly_connected" | "reactivated" | "already_connected" | "error";
  scope_provisioning: "ok" | "failed" | "skipped";
  reindex_triggered: boolean;
  /** Set by the caller alongside reindex_triggered; poll with personal_reindex_status. */
  reindex_job_id?: string;
  message?: string;
  error?: string;
}

export async function connectSource(
  env: PersonalEnv,
  userId: string,
  source: string
): Promise<ConnectSourceResult> {
  const sql = personalDb(env);
  const schema = getKnowledgeSchema(env);
  const githubInstallationsTable = KNOWLEDGE_TABLES.github_installations(schema);
  const userSourcesTable = KNOWLEDGE_TABLES.user_sources(schema);

  const installRows = await sql`
    SELECT github_username, repos FROM ${sql.unsafe(githubInstallationsTable)}
    WHERE user_id = ${userId}
    LIMIT 1
  `;
  if (installRows.length === 0) {
    return {
      source, status: "error", scope_provisioning: "skipped", reindex_triggered: false,
      error: "GitHub App не подключён. Сначала выполни github_connect и установи App.",
    };
  }
  // Rows written before github-integration-service's sql.json() fix (cf8c3cf) store repos
  // as a jsonb *string* scalar instead of an array (postgres.js quirk with
  // JSON.stringify(x)::jsonb) — a bare cast let a lookup miss crash on repos.join() instead
  // of erroring cleanly (ported bug — same as personal-knowledge-mcp/src/index.ts
  // connectSource, see comment above this function). Recover the legacy shape.
  const rawRepos = installRows[0].repos;
  let repos: string[];
  if (Array.isArray(rawRepos)) {
    repos = rawRepos as string[];
  } else if (typeof rawRepos === "string") {
    try {
      const parsed = JSON.parse(rawRepos);
      repos = Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      repos = [];
    }
  } else {
    repos = [];
  }
  const githubUsername = installRows[0].github_username as string;
  if (!repos.includes(source)) {
    const available = repos.length > 0 ? repos.join(", ") : "нет ни одного";
    return {
      source, status: "error", scope_provisioning: "skipped", reindex_triggered: false,
      error: `Репо '${source}' не входит в твою GitHub App installation. Доступные: ${available}.`,
    };
  }

  const currentRows = await sql`
    SELECT active FROM ${sql.unsafe(userSourcesTable)}
    WHERE user_id = ${userId} AND source = ${source}
    LIMIT 1
  `;
  const wasActive = currentRows.length > 0 ? (currentRows[0].active as boolean) : null;

  let resultStatus: "newly_connected" | "reactivated" | "already_connected";
  if (wasActive === null) {
    await sql`
      INSERT INTO ${sql.unsafe(userSourcesTable)} (user_id, source, github_owner, github_repo, source_type, active)
      VALUES (${userId}, ${source}, ${githubUsername}, ${source}, ${inferSourceType(source)}, true)
      ON CONFLICT (user_id, source) DO UPDATE SET active = true,
        github_owner = EXCLUDED.github_owner, github_repo = EXCLUDED.github_repo
    `;
    resultStatus = "newly_connected";
  } else if (wasActive === false) {
    await sql`
      UPDATE ${sql.unsafe(userSourcesTable)} SET active = true
      WHERE user_id = ${userId} AND source = ${source}
    `;
    resultStatus = "reactivated";
  } else {
    resultStatus = "already_connected";
  }

  // WP-410: provision bridge write-scopes in-process — unconditional on every connect so a
  // revoked/lost scope row self-heals on re-connect (idempotent upsert).
  let scopeProvisioning: "ok" | "failed" | "skipped" = "skipped";
  if (env.INDICATORS_DATABASE_URL) {
    try {
      await provisionBridgeScopes(neon(env.INDICATORS_DATABASE_URL), userId, source);
      scopeProvisioning = "ok";
    } catch (err) {
      scopeProvisioning = "failed";
      console.error(JSON.stringify({
        phase: "bridge_scopes_provision_failed",
        severity: "error",
        user_id_prefix: userId.slice(0, 8),
        source,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  return {
    source,
    status: resultStatus,
    scope_provisioning: scopeProvisioning,
    // Caller (../index.ts) overwrites reindex_triggered + message with the real outcome
    // when scope_provisioning === "ok" (calls startReindexJob right after this returns).
    reindex_triggered: false,
    message: scopeProvisioning === "failed"
      ? "репо подключён для чтения, но запись пока не разрешена — повтори connect_source"
      : "репо подключено, права на запись выданы.",
  };
}

// Mirror knowledge-mcp/migrations/008-unique-per-user.sql:resolveSourceType.
function inferSourceType(source: string): "pack" | "guides" | "ds" {
  if (source.startsWith("PACK-") || source === "SPF" || source === "FPF" || source === "ZP") return "pack";
  if (source.startsWith("docs-") || source.endsWith("-docs")) return "guides";
  return "ds";
}

// --- WP-410 Деплой-2 группа А: admin tools ported from personal-knowledge-mcp/src/index.ts ---

export interface DisconnectResult {
  source: string;
  status: "disconnected" | "already_disconnected";
  documents_kept: number;
  error?: string;
}

/**
 * Lazy disconnect: UPDATE user_sources.active=false. Documents/embeddings kept —
 * re-activate via connectSource does not require a full reindex.
 * Faithful port of personal-knowledge-mcp/src/index.ts:2825 disconnectSource.
 */
export async function disconnectSource(
  env: PersonalEnv,
  userId: string,
  source: string
): Promise<DisconnectResult> {
  const sql = personalDb(env);
  const schema = getKnowledgeSchema(env);
  const userSourcesTable = KNOWLEDGE_TABLES.user_sources(schema);
  const documentsTable = KNOWLEDGE_TABLES.documents(schema);

  const currentRows = await sql`
    SELECT active FROM ${sql.unsafe(userSourcesTable)}
    WHERE user_id = ${userId} AND source = ${source}
    LIMIT 1
  `;
  if (currentRows.length === 0) {
    return { source, status: "already_disconnected", documents_kept: 0,
      error: `Source '${source}' не подключён. Проверь list_sources.` };
  }
  const wasActive = currentRows[0].active as boolean;
  if (!wasActive) {
    const docRows = await sql`
      SELECT COUNT(*)::int AS cnt FROM ${sql.unsafe(documentsTable)}
      WHERE user_id = ${userId} AND source = ${source}
    `;
    return { source, status: "already_disconnected", documents_kept: (docRows[0].cnt as number) ?? 0 };
  }

  await sql`
    UPDATE ${sql.unsafe(userSourcesTable)} SET active = false
    WHERE user_id = ${userId} AND source = ${source}
  `;
  const docRows = await sql`
    SELECT COUNT(*)::int AS cnt FROM ${sql.unsafe(documentsTable)}
    WHERE user_id = ${userId} AND source = ${source}
  `;
  return { source, status: "disconnected", documents_kept: (docRows[0].cnt as number) ?? 0 };
}

export interface PurgeResult {
  source: string;
  status: "purged" | "not_found";
  documents_deleted: number;
  jobs_deleted: number;
  error?: string;
}

/**
 * GDPR hard delete: removes documents, reindex_jobs, and the user_sources row for a
 * source. Irreversible — caller (dispatcher) must require an explicit confirm=true.
 * Faithful port of personal-knowledge-mcp/src/index.ts:2868 purgeSource.
 */
export async function purgeSource(
  env: PersonalEnv,
  userId: string,
  source: string
): Promise<PurgeResult> {
  const sql = personalDb(env);
  const schema = getKnowledgeSchema(env);
  const userSourcesTable = KNOWLEDGE_TABLES.user_sources(schema);
  const documentsTable = KNOWLEDGE_TABLES.documents(schema);
  const reindexJobsTable = KNOWLEDGE_TABLES.reindex_jobs(schema);

  const sourceRows = await sql`
    SELECT source FROM ${sql.unsafe(userSourcesTable)}
    WHERE user_id = ${userId} AND source = ${source}
    LIMIT 1
  `;
  if (sourceRows.length === 0) {
    return { source, status: "not_found", documents_deleted: 0, jobs_deleted: 0,
      error: `Source '${source}' не найден. Проверь list_sources.` };
  }

  const [docResult, jobResult] = await Promise.all([
    sql`
      WITH deleted AS (
        DELETE FROM ${sql.unsafe(documentsTable)}
        WHERE user_id = ${userId} AND source = ${source}
        RETURNING id
      )
      SELECT COUNT(*)::int AS cnt FROM deleted
    `,
    sql`
      WITH deleted AS (
        DELETE FROM ${sql.unsafe(reindexJobsTable)}
        WHERE user_id = ${userId} AND source = ${source}
        RETURNING id
      )
      SELECT COUNT(*)::int AS cnt FROM deleted
    `,
  ]);

  await sql`
    DELETE FROM ${sql.unsafe(userSourcesTable)}
    WHERE user_id = ${userId} AND source = ${source}
  `;

  return {
    source,
    status: "purged",
    documents_deleted: (docResult[0].cnt as number) ?? 0,
    jobs_deleted: (jobResult[0].cnt as number) ?? 0,
  };
}
