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

export interface PersonalEnv {
  // Optional at the Env-interface level (only bound when MCP_MODE=private) — required at
  // call time; personalDb() throws a clear error rather than passing undefined to neon().
  DATABASE_URL?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  KNOWLEDGE_DB_SCHEMA?: string;
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

function personalDb(env: PersonalEnv) {
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
async function getInstallationToken(env: PersonalEnv, owner: string): Promise<string | null> {
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
  message: string
): Promise<{ success: boolean; sha?: string; url?: string; error?: string }> {
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
    return { success: false, error: `GitHub API error ${putResp.status}: ${err}` };
  }

  const result = (await putResp.json()) as { content: { sha: string; html_url: string } };
  return { success: true, sha: result.content.sha, url: result.content.html_url };
}
