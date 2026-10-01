/**
 * GitHub REST API reads with an optional token (WP-532 Ф9 follow-up, 2026-10-01).
 *
 * The worker used to call api.github.com anonymously. The anonymous quota is 60 requests per hour
 * per egress address, and that address is shared, so every source's quarter-hourly heartbeat ended
 * in "GitHub rate-limited ... reset_at=" and the daily FPF/SPF pass died with "GitHub Trees API
 * 403" before the batched ingest of FPF-Spec.md could start. A token (even one with no
 * permissions, for public repositories) moves the caller onto its own 5000 requests per hour.
 *
 * Rules kept here, not at the call sites:
 *  - the token goes only to https://api.github.com/, never to another host, and redirects are
 *    followed by hand so the token cannot ride along to a different host;
 *  - a rejected token (401: expired or revoked) retries once anonymously, so an expired secret
 *    degrades to the previous behaviour instead of breaking reads that worked without it;
 *  - the token value never reaches a log line.
 */

const USER_AGENT = "aisystant-knowledge-mcp";
const API_ORIGIN = "https://api.github.com/";
/** GitHub answers a renamed or transferred repository with a redirect to the same host. */
const MAX_REDIRECTS = 3;
/** Log a warning once the remaining quota drops to this share of the limit. */
const LOW_QUOTA_FRACTION = 0.1;

export function githubApiHeaders(token: string | undefined, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT, ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Makes a quota problem visible before it turns into a 403: authenticated=false with a limit of
 *  60 also tells the reader that the token is missing or was dropped. */
function warnWhenQuotaLow(resp: Response, authenticated: boolean): void {
  const limitRaw = resp.headers.get("X-RateLimit-Limit");
  const remainingRaw = resp.headers.get("X-RateLimit-Remaining");
  if (limitRaw === null || remainingRaw === null) return;
  const limit = Number(limitRaw);
  const remaining = Number(remainingRaw);
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0) return;
  if (remaining <= limit * LOW_QUOTA_FRACTION) {
    console.warn(JSON.stringify({ phase: "github_quota_low", authenticated, limit, remaining }));
  }
}

/** The same-host target of a redirect response, or null when it must not be followed with the token. */
function sameHostRedirectTarget(resp: Response, from: string): string | null {
  const location = resp.headers.get("Location");
  if (resp.status < 300 || resp.status >= 400 || !location) return null;
  let target: string;
  try {
    target = new URL(location, from).toString();
  } catch {
    return null;
  }
  return target.startsWith(API_ORIGIN) ? target : null;
}

/** Sends the token on every hop, but only to api.github.com: a redirect elsewhere is returned to
 *  the caller as the 3xx response it is, never followed. */
async function fetchWithToken(url: string, token: string, extraHeaders: Record<string, string>): Promise<Response> {
  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const resp = await fetch(target, { headers: githubApiHeaders(token, extraHeaders), redirect: "manual" });
    const next = sameHostRedirectTarget(resp, target);
    if (next === null) return resp;
    await resp.body?.cancel();
    target = next;
  }
  throw new Error(`GitHub redirect limit (${MAX_REDIRECTS}) exceeded`);
}

/**
 * fetch() for a GitHub REST URL. Pass `token` as `env.GITHUB_TOKEN`; undefined keeps the
 * anonymous behaviour of the worker before this change.
 */
export async function fetchGitHubApi(
  url: string,
  token: string | undefined,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  if (!token || !url.startsWith(API_ORIGIN)) {
    const anonymous = await fetch(url, { headers: githubApiHeaders(undefined, extraHeaders) });
    warnWhenQuotaLow(anonymous, false);
    return anonymous;
  }

  const resp = await fetchWithToken(url, token, extraHeaders);
  if (resp.status === 401) {
    console.error(JSON.stringify({ phase: "github_token_rejected", host: "api.github.com" }));
    await resp.body?.cancel();
    const anonymous = await fetch(url, { headers: githubApiHeaders(undefined, extraHeaders) });
    warnWhenQuotaLow(anonymous, false);
    return anonymous;
  }

  warnWhenQuotaLow(resp, true);
  return resp;
}
