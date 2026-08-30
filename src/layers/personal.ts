// Personal-corpus data layer for the private MCP mode (WP-410 срез-2b).
// Ported from personal-knowledge-mcp/src/index.ts as-is (faithful port, no behavior change):
// resolveUserContext, GitHub App JWT signing, writeToGitHub, getInstallationToken.
//
// Talks to the personal Neon DB (env.DATABASE_URL) via plain neon() + explicit `WHERE user_id`
// (NOT the RLS/withUserContext machinery in ../rls.ts — that machinery is scoped to the
// knowledge DB's own RLS migrations, which do not exist for user_sources on the personal DB;
// see security-gate-b73-private-port.md §2, "не RLS — подтверждено 2026-06-11, relrowsecurity=f").

import { neon } from "@neondatabase/serverless";
import { getKnowledgeSchema, KNOWLEDGE_TABLES } from "../utils/db.js";
import { provisionBridgeScopes } from "../scope.js";

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

// Exported for reuse by ./reindex.ts (WP-410 Деплой-2 группа Б) — same personal Neon DB.
export function personalDb(env: PersonalEnv) {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for private-mode personal data access");
  }
  return neon(env.DATABASE_URL);
}

type PersonalSql = ReturnType<typeof personalDb>;

/** Literal chunk-key prefix — `%`/`_` in `path` stay literal (WP-7 Ф94, faithful
 * port of personal-knowledge-mcp/src/index.ts:documentChunkPrefix). */
export function documentChunkPrefix(path: string): string {
  return `${path}::`;
}

/** A canonical path can't be indexed if it contains "::" — reserved as the legacy
 * (protocol_version=1) chunk-key separator (WP-7 Ф94). */
export function assertIndexablePath(path: string): void {
  if (path.includes("::")) {
    throw new Error(`path contains reserved chunk separator "::": ${path}`);
  }
}

/** Un-awaited DELETE query (exact filename + literal chunk prefix), reusable
 * directly inside sql.transaction([...]) — same shape as
 * personal-knowledge-mcp/src/index.ts:buildDeleteDocumentQuery. */
export function buildDeleteDocumentQuery(
  sql: PersonalSql,
  documentsTable: string,
  source: string,
  userId: string,
  filename: string,
) {
  const chunkPrefix = documentChunkPrefix(filename);
  return sql`DELETE FROM ${sql.unsafe(documentsTable)} WHERE source = ${source} AND user_id = ${userId} AND (filename = ${filename} OR left(filename, char_length(${chunkPrefix})) = ${chunkPrefix})`;
}

/** Thrown when `filename` matches an indexed document in 2+ connected sources and
 * `source` wasn't given (WP-7 Ф94, same contract as personal-knowledge-mcp). */
export class AmbiguousSourceError extends Error {
  constructor(public readonly sources: string[]) {
    super(`filename exists in multiple sources: ${sources.join(", ")}`);
  }
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
  expectedSha?: string,
): Promise<{ success: boolean; sha?: string; url?: string; error?: string; reason?: string; current_sha?: string | null }> {
  const userSource = ctx.sources.find(s => s.source === source);
  if (!userSource) return { success: false, error: `Unknown source: ${source}` };

  const owner = userSource.githubOwner;
  const repo = userSource.githubRepo;
  const token = await getInstallationToken(env, owner);
  if (!token) return { success: false, error: `No GitHub App installation found for ${owner}. Install the app: https://github.com/apps/aisystant-knowledge` };

  const fullPath = userSource.pathPrefix ? `${userSource.pathPrefix}${path}` : path;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${fullPath}`;

  // Check if file exists (need sha for update)
  let existingSha: string | undefined;
  const getResp = await fetch(apiUrl, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "aisystant-knowledge" },
  });
  if (getResp.ok) {
    const existing = (await getResp.json()) as { sha: string };
    existingSha = existing.sha;
  }

  // Optimistic concurrency (WP-7 Ф96 — ported from personal-knowledge-mcp/
  // src/index.ts:writeToGitHub, same worker per Ф94's two-trees finding).
  // expectedSha comes from a prior personalGetDocument(includeSha: true)
  // call; checked here, before the PUT below, so a caller editing a version
  // someone else already replaced gets version_mismatch instead of silently
  // overwriting it.
  if (expectedSha !== undefined) {
    // A malformed value ("", truncated hex) is a caller bug, not a concurrent
    // edit — version_mismatch here would send the agent into a pointless
    // reread loop (peer-review finding, verify session 30.08).
    if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(expectedSha)) {
      return { success: false, reason: "invalid_expected_sha", error: "expected_sha должен быть 40-символьным hex sha из get_document(include_sha: true); при создании нового файла параметр не передавай вовсе." };
    }
    // Case-insensitive: GitHub returns lowercase, the schema accepts
    // uppercase hex — a case-only difference is the same version, not a
    // concurrent edit (peer-review round 2, 30.08).
    if (existingSha?.toLowerCase() !== expectedSha.toLowerCase()) {
      return { success: false, reason: "version_mismatch", current_sha: existingSha ?? null, error: "Файл изменился с момента чтения — перечитай personal_get_document(includeSha: true) и повтори запись." };
    }
  }

  // Create or update file
  const putResp = await fetch(apiUrl, {
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
    // 409 (or a 422 whose message names the sha) = a concurrent-edit race in
    // the GET→PUT gap; other 422s are unrelated validation failures and must
    // not masquerade as concurrent edits (peer-review finding, 30.08).
    if (putResp.status === 409 || (putResp.status === 422 && /sha/i.test(err))) {
      return { success: false, reason: "version_mismatch", current_sha: null, error: `Файл изменился во время записи (GitHub ${putResp.status}): ${err}` };
    }
    if (putResp.status === 422) {
      return { success: false, reason: "github_validation_error", error: `GitHub отклонил запись (422): ${err}` };
    }
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
  message: string
): Promise<{ success: boolean; error?: string }> {
  const userSource = ctx.sources.find(s => s.source === source);
  if (!userSource) return { success: false, error: `Unknown source: ${source}` };

  const owner = userSource.githubOwner;
  const repo = userSource.githubRepo;
  const token = await getInstallationToken(env, owner);
  if (!token) return { success: false, error: `No GitHub App installation found for ${owner}. Install the app: https://github.com/apps/aisystant-knowledge` };

  const fullPath = userSource.pathPrefix ? `${userSource.pathPrefix}${path}` : path;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${fullPath}`;

  const getResp = await fetch(apiUrl, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "aisystant-knowledge" },
  });
  if (!getResp.ok) {
    return { success: false, error: `File not found: ${path} in ${source}` };
  }
  const existing = (await getResp.json()) as { sha: string };

  const delResp = await fetch(apiUrl, {
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
  await buildDeleteDocumentQuery(sql, documentsTable, source, ctx.userId, path);

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
  const prefix = userSource.pathPrefix ? `${userSource.pathPrefix}/` : "";
  return `https://github.com/${userSource.githubOwner}/${userSource.githubRepo}/blob/main/${prefix}${cleanFilename}`;
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

/** Private-mode `get_document`: personal corpus only.
 * Reads the new chunk_ordinal format first (aggregating every chunk of the
 * document in order); falls back to the legacy LIMIT-1 read only while a
 * document hasn't been backfilled yet, so behavior never regresses during
 * the transition (WP-7 Ф94). */
export async function personalGetDocument(
  env: PersonalEnv,
  ctx: UserContext,
  filename: string,
  source?: string
): Promise<{ filename: string; content: string; source: string; source_type: string; github_url: string | null } | null> {
  const sql = personalDb(env);
  const schema = getKnowledgeSchema(env);
  const documentsTable = KNOWLEDGE_TABLES.documents(schema);
  const src = source ?? null;
  const sourceNames = ctx.sourceNames;
  const normalizedFilename = filename.includes("::") ? filename.split("::")[0] : filename;
  const chunkPrefix = documentChunkPrefix(normalizedFilename);

  // Ambiguity check runs across BOTH protocol versions together, before any
  // data query — checking only v2 (or only legacy) rows would silently miss
  // the migration-window case where source A is backfilled to v2 and source B
  // still holds a v1 copy of the same filename (WP-7 Ф94, cold-context review).
  if (src === null) {
    const distinctSources = await sql`
      SELECT DISTINCT source FROM ${sql.unsafe(documentsTable)}
      WHERE (filename = ${normalizedFilename} OR left(filename, char_length(${chunkPrefix})) = ${chunkPrefix})
        AND user_id = ${ctx.userId} AND source = ANY(${sourceNames})
    `;
    if (distinctSources.length > 1) throw new AmbiguousSourceError(distinctSources.map(r => r.source as string));
  }

  const v2Rows = await sql`
    SELECT filename, content, source, source_type, chunk_ordinal
    FROM ${sql.unsafe(documentsTable)}
    WHERE filename = ${normalizedFilename}
      AND protocol_version = 2
      AND user_id = ${ctx.userId}
      AND source = ANY(${sourceNames})
      AND (${src}::text IS NULL OR source = ${src})
    ORDER BY chunk_ordinal
  `;

  if (v2Rows.length > 0) {
    const r0 = v2Rows[0];
    return {
      filename: r0.filename as string,
      content: v2Rows.map(r => r.content as string).join(""),
      source: (r0.source as string) || "",
      source_type: (r0.source_type as string) || "",
      github_url: personalGithubUrl(ctx, (r0.source as string) || "", r0.filename as string),
    };
  }

  const rows = await sql`
    SELECT filename, content, source, source_type
    FROM ${sql.unsafe(documentsTable)}
    WHERE (filename = ${normalizedFilename} OR left(filename, char_length(${chunkPrefix})) = ${chunkPrefix})
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

/** Canonicalize a repository-relative path for the live-read: reject escape
 * attempts and encode each segment for URL use. Minimal local port of
 * personal-knowledge-mcp's normalizeRepositoryPath/encodeGitHubContentsPath —
 * the plain string concatenation the first version used let `../`, `#` and
 * `?` reach the Contents API URL raw (peer-review finding, verify session
 * 30.08). Throws on an invalid path. */
export function canonicalContentsPath(pathPrefix: string, filename: string): string {
  if (!filename || filename.includes("\0") || filename.includes("\\") || filename.startsWith("/")) {
    throw new Error(`invalid repository path: ${filename}`);
  }
  const segments: string[] = [];
  for (const seg of filename.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (segments.length === 0) throw new Error(`invalid repository path: ${filename}`);
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  if (segments.length === 0) throw new Error(`invalid repository path: ${filename}`);
  // The prefix comes from the user_sources DB row, but gets the same
  // treatment: a "..", backslash or NUL there would step outside the
  // source's logical root just as surely as one in the filename
  // (peer-review round 2, 30.08 — defense in depth, no dot-segment
  // resolution for config values: any ".." is an error outright).
  const prefixSegments: string[] = [];
  if (pathPrefix) {
    if (pathPrefix.includes("\0") || pathPrefix.includes("\\")) {
      throw new Error(`invalid path prefix: ${pathPrefix}`);
    }
    for (const seg of pathPrefix.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") throw new Error(`invalid path prefix: ${pathPrefix}`);
      prefixSegments.push(seg);
    }
  }
  return [...prefixSegments, ...segments].map(encodeURIComponent).join("/");
}

/** Read a document straight from GitHub instead of the (async, occasionally
 * stale) Neon index — used only when the caller declared intent to write
 * (get_document{ includeSha: true }). content and sha come from the SAME
 * Contents API response so a caller who round-trips this sha back into
 * write is always comparing against the version of content they actually
 * saw (WP-7 Ф96 — ported from personal-knowledge-mcp/src/index.ts:
 * getDocumentLive, same worker per Ф94's two-trees finding). */
export async function personalGetDocumentLive(
  env: PersonalEnv,
  ctx: UserContext,
  filename: string,
  source: string,
): Promise<{ filename: string; content: string; source: string; source_type: string; github_url: string | null; sha: string } | null> {
  const userSource = ctx.sources.find(s => s.source === source);
  if (!userSource) return null;

  let encodedPath: string;
  try {
    encodedPath = canonicalContentsPath(userSource.pathPrefix, filename);
  } catch {
    return null;
  }

  const owner = userSource.githubOwner;
  const repo = userSource.githubRepo;
  const token = await getInstallationToken(env, owner);
  if (!token) return null;

  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;

  // External response parsing (json, atob, UTF-8 decode) can throw; the
  // dispatch layer expects null, not an exception.
  try {
    const response = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "aisystant-knowledge" },
    });
    if (!response.ok) return null;

    const body = (await response.json()) as { sha?: unknown; content?: unknown; encoding?: unknown };
    // Same sha shape check as the write path — a malformed sha handed out
    // here would be rejected by write(expected_sha) later anyway, better to
    // fail the read (peer-review round 2, 30.08).
    if (typeof body.sha !== "string" || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(body.sha) || typeof body.content !== "string" || body.encoding !== "base64") return null;

    return {
      filename,
      content: decodeURIComponent(escape(atob(body.content.replace(/\n/g, "")))),
      source,
      source_type: userSource.sourceType,
      github_url: personalGithubUrl(ctx, source, filename),
      sha: body.sha,
    };
  } catch {
    return null;
  }
}

/** include_sha=true handler: live-first read with the index only as a source
 * hint — an index miss must NOT fail the call, bypassing a stale index is
 * what include_sha is FOR (peer-review finding, verify session 30.08;
 * mirror of personal-knowledge-mcp's getDocumentWithSha). */
export async function personalGetDocumentWithSha(
  env: PersonalEnv,
  ctx: UserContext,
  filename: string,
  source?: string,
): Promise<
  | { kind: "document"; filename: string; content: string; source: string; source_type: string; github_url: string | null; sha: string }
  | { kind: "source_required"; sources: string[] }
  | null
> {
  const normalized = filename.includes("::") ? filename.split("::")[0] : filename;

  let resolvedSource = source;
  if (!resolvedSource && ctx.sourceNames.length === 1) {
    // A single connected source is already unambiguous — resolving it before
    // the index keeps the live read working even when the index query itself
    // fails (peer-review round 2, 30.08).
    resolvedSource = ctx.sourceNames[0];
  }
  if (!resolvedSource) {
    // Index as a hint only; AmbiguousSourceError propagates as in the plain path.
    const indexed = await personalGetDocument(env, ctx, normalized);
    if (indexed) {
      resolvedSource = indexed.source;
    } else {
      return { kind: "source_required", sources: ctx.sourceNames };
    }
  }

  const live = await personalGetDocumentLive(env, ctx, normalized, resolvedSource);
  return live ? { kind: "document", ...live } : null;
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
