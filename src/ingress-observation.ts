// WP-560 Ф19 stage 1: inventory of callers that reach this worker directly instead of
// through gateway-mcp. One structured log line per HTTP request, built only from closed
// lists and coarse classes: no header values, no tokens, no user or request ids, no query
// text, no IP. Unknown values collapse to "other", so a new client shows up as a class,
// never as raw data.

export const INGRESS_EVENT = "knowledge_ingress";

const KNOWN_PATHS = new Set(["/mcp", "/reindex", "/reindex-full", "/provision-bridge-scopes", "/full-ingest", "/health", "/"]);
const KNOWN_RPC_METHODS = new Set(["initialize", "notifications/initialized", "tools/list", "tools/call", "ping"]);
const KNOWN_ORIGINS = new Set(["iwe.system-school.ru", "claude.ai", "chatgpt.com", "chat.openai.com"]);

// Order matters: the first matching class wins (a browser UA also contains "Mozilla").
const USER_AGENT_CLASSES: ReadonlyArray<readonly [string, RegExp]> = [
  ["gateway", /gateway-mcp/],
  ["claude", /claude-user|anthropic|claude/],
  ["openai", /openai-mcp|chatgpt/],
  ["n8n", /n8n/],
  ["python", /python|aiohttp|httpx|urllib/],
  ["node", /node|undici|axios/],
  ["curl", /curl|wget/],
  ["go", /go-http-client/],
  ["browser", /mozilla/],
];

// "bearer_unchecked": a Bearer was present but no JWT check ran (non-/mcp routes use shared
// secrets; /mcp without ORY_URL ignores the Bearer), so it says nothing about validity.
export type AuthKind = "jwt_verified" | "bearer_unverified" | "bearer_unchecked" | "x_user_id" | "none";

// Shape of a parsed /mcp body: "batch" (JSON array) and "invalid" (not an object, or not JSON)
// are classes of their own so such callers can be counted.
const NOT_PARSED = Symbol("not-parsed");
export const PARSE_FAILED = Symbol("parse-failed");

export interface IngressEvent {
  event: typeof INGRESS_EVENT;
  mode: "public" | "private";
  path: string;
  http_method: string;
  // "edge": the request carries the header Cloudflare sets on internet traffic; a
  // service-binding call from another Worker does not get it. A Worker calling a public
  // hostname is "edge" too, so gateway traffic is told apart by gateway_marker instead.
  entry: "edge" | "internal";
  // gateway-mcp's proxy always sends X-Request-Id (gateway src/index.ts proxyMcpRequest);
  // presence only, the value is never logged. A direct client may send it too: a hint, not proof.
  gateway_marker: boolean;
  auth: AuthKind;
  service_header: boolean;
  user_agent: string;
  origin: string;
  rpc_method: string | null;
  tool: string | null;
}

export function classifyUserAgent(value: string | null): string {
  if (!value) return "none";
  const lower = value.toLowerCase();
  for (const [name, pattern] of USER_AGENT_CLASSES) {
    if (pattern.test(lower)) return name;
  }
  return "other";
}

export function classifyOrigin(value: string | null): string {
  if (!value) return "none";
  let host: string;
  try {
    host = new URL(value).hostname;
  } catch {
    return "other";
  }
  return KNOWN_ORIGINS.has(host) ? host : "other";
}

export function classifyAuth(request: Request, jwtSubject: string | undefined, jwtChecked: boolean): AuthKind {
  const authorization = request.headers.get("Authorization");
  if (authorization?.startsWith("Bearer ")) {
    if (!jwtChecked) return "bearer_unchecked";
    return jwtSubject !== undefined ? "jwt_verified" : "bearer_unverified";
  }
  if (request.headers.get("x-user-id")) return "x_user_id";
  return "none";
}

function classifyRpc(body: unknown, isKnownTool: (name: string) => boolean): { rpcMethod: string | null; tool: string | null } {
  if (body === NOT_PARSED) return { rpcMethod: null, tool: null };
  if (Array.isArray(body)) return { rpcMethod: "batch", tool: null };
  if (body === PARSE_FAILED || body === null || typeof body !== "object") return { rpcMethod: "invalid", tool: null };
  const { method, params } = body as { method?: unknown; params?: unknown };
  const rpcMethod = typeof method === "string" ? (KNOWN_RPC_METHODS.has(method) ? method : "other") : "invalid";
  if (rpcMethod !== "tools/call") return { rpcMethod, tool: null };
  const name = params !== null && typeof params === "object" ? (params as { name?: unknown }).name : undefined;
  return { rpcMethod, tool: typeof name === "string" && isKnownTool(name) ? name : "other" };
}

export function buildIngressEvent(
  request: Request,
  mode: "public" | "private",
  options: {
    jwtSubject?: string;
    // True only where a JWT check actually ran (the /mcp branch with ORY_URL set).
    jwtChecked?: boolean;
    // The parsed /mcp body, or PARSE_FAILED; omitted for requests whose body is not read.
    body?: unknown;
    isKnownTool: (name: string) => boolean;
    serviceHeaderName: string;
  },
): IngressEvent {
  const url = new URL(request.url);
  const { rpcMethod, tool } = classifyRpc("body" in options ? options.body : NOT_PARSED, options.isKnownTool);
  return {
    event: INGRESS_EVENT,
    mode,
    path: KNOWN_PATHS.has(url.pathname) ? url.pathname : "other",
    http_method: ["GET", "POST", "OPTIONS"].includes(request.method) ? request.method : "other",
    entry: request.headers.has("cf-connecting-ip") ? "edge" : "internal",
    gateway_marker: request.headers.has("x-request-id"),
    auth: classifyAuth(request, options.jwtSubject, options.jwtChecked === true),
    service_header: request.headers.has(options.serviceHeaderName),
    user_agent: classifyUserAgent(request.headers.get("User-Agent")),
    origin: classifyOrigin(request.headers.get("Origin")),
    rpc_method: rpcMethod,
    tool,
  };
}
