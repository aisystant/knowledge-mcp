// Shared Ory JWT verification (WP-410 Q1 slice 2b).
// Extracted from index.ts so layers/private.ts can import it without a circular
// dependency (index.ts already imports from layers/private.ts).

import { createRemoteJWKSet, jwtVerify } from "jose";

const _jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(oryUrl: string): ReturnType<typeof createRemoteJWKSet> {
  if (!_jwksCache.has(oryUrl)) {
    // ORY_URL is the Hydra base URL (e.g. https://auth.system-school.ru/hydra)
    // JWKS is served at <oryUrl>/.well-known/jwks.json — same pattern as gateway-mcp
    const jwksUrl = new URL(`${oryUrl}/.well-known/jwks.json`);
    _jwksCache.set(oryUrl, createRemoteJWKSet(jwksUrl));
  }
  return _jwksCache.get(oryUrl)!;
}

export async function verifyJwtLocally(oryUrl: string, token: string): Promise<string | null> {
  try {
    const jwks = getJwks(oryUrl);
    const issuer = oryUrl.endsWith("/") ? oryUrl : oryUrl + "/";
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      algorithms: ["RS256"],
    });
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

/** Extract the Bearer token from a request's Authorization header, or null if absent/malformed. */
export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

/** Constant-time string comparison for shared-secret checks — a plain ===
 * leaks a timing signal on how many leading bytes matched (WP-7 Ф95
 * peer-review; manual XOR fold so the same code runs under Node tests). */
export function secretsEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
