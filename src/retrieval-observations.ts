import { Pool, type PoolClient } from "@neondatabase/serverless";

export const OBSERVATION_RETENTION_DAYS = 90;

/** Separate, least-privilege credentials; never reuse an owner/BYPASSRLS connection. */
export interface ObservationEnv {
  RETRIEVAL_OBSERVATION_DATABASE_URL?: string;
  RETRIEVAL_OBSERVATION_MODE?: string;
  RETRIEVAL_OBSERVATION_ACCOUNTS?: string;
  RETRIEVAL_OBSERVATION_HMAC_KEY?: string;
  RETRIEVAL_OBSERVATION_TEXT_DAYS?: string;
  CF_VERSION_METADATA?: { id: string };
}

export interface ObservationRuntime {
  /** Assigned by the HTTP JWT verifier, never from x-user-id or tool arguments. */
  verifiedAccountId?: string;
  waitUntil: (task: Promise<unknown>) => void;
}

export interface ObservationTicket {
  id: string;
  accountId: string;
  mode: "public" | "private";
  observedAt: string;
  textDays: number | null;
  runtime: ObservationRuntime;
}

type Hit = { indexed_content_hash?: string; id: number; content: string; parent_content?: string; source?: string; filename?: string };
type ToolResponse = { result?: unknown };

export interface SearchObservation {
  id: string;
  accountId: string;
  mode: "public" | "private";
  observedAt: string;
  queryFingerprint: string;
  queryText: string | null;
  textExpiresAt: string | null;
  textDisposition: "disabled" | "private" | "filtered" | "retained";
  workerVersion: string | null;
  snapshot: {
    version: 1;
    availableCount: number;
    returnedCount: number;
    omittedHits: boolean;
    hits: { id: number; rank: number; sourceRef: string; indexedContentHash: string | null; retrievedContentHash: string;
      returnedContentHash: string; returnedParentHash: string | null; excerpted: boolean }[];
  };
}

function enabled(env: ObservationEnv): boolean {
  return ["hash", "platform-text"].includes(env.RETRIEVAL_OBSERVATION_MODE ?? "")
    && !!env.RETRIEVAL_OBSERVATION_DATABASE_URL
    && (env.RETRIEVAL_OBSERVATION_HMAC_KEY?.length ?? 0) >= 32;
}

function admittedAccount(env: ObservationEnv, runtime: ObservationRuntime | undefined): string | undefined {
  const accountId = runtime?.verifiedAccountId;
  const allowed = (env.RETRIEVAL_OBSERVATION_ACCOUNTS ?? "").split(",").map(value => value.trim());
  return enabled(env) && accountId && allowed.includes(accountId) ? accountId : undefined;
}

export function beginObservation(
  env: ObservationEnv, runtime: ObservationRuntime | undefined, mode: "public" | "private",
): ObservationTicket | undefined {
  const accountId = admittedAccount(env, runtime);
  if (!runtime || !accountId) return;
  const days = Number(env.RETRIEVAL_OBSERVATION_TEXT_DAYS ?? OBSERVATION_RETENTION_DAYS);
  // Approved raw-record lifetime is 90 days; text may have a shorter window.
  // Invalid explicit overrides degrade to hashes, never extend record lifetime.
  const textDays = env.RETRIEVAL_OBSERVATION_MODE === "platform-text"
    && Number.isInteger(days) && days >= 1 && days <= OBSERVATION_RETENTION_DAYS ? days : null;
  return { id: crypto.randomUUID(), accountId, mode, observedAt: new Date().toISOString(), textDays, runtime };
}

// Publication-filter secret families, plus conservative PII heuristics. This is not
// proof of anonymisation: names/free prose can still be personal data. RLS remains mandatory.
const SENSITIVE_PATTERNS = [
  /Bearer\s+\S+/i, /\b(?:sk-|ghp_|gho_|github_pat_|xox[baprs]-|xoxe-)[\w-]+/i,
  /\bAKIA[0-9A-Z]{16}\b/, /\bAIza[\w-]{35}/, /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/,
  /\b\d{8,}:[\w-]{35}/, /\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/,
  /(?:mongodb|postgres(?:ql)?|mysql|redis|https?)(?:\+srv)?:\/\/[^\s/]+:[^\s/]+@/i,
  /\bM[\w-]{23}\.[\w-]{6}\.[\w-]{27}\b/, /\b\d{3}-\d{3}-\d{3}\s\d{2}\b/,
  /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i, /(?:\+?\d[\s().-]*){10,}/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  /(?:password|passwd|secret|api[_ -]?key|пароль|токен)\s*[:=]\s*\S+/i,
];

export function mayRetainQueryText(query: string): boolean {
  return query.length > 0 && query.length <= 4_000
    && !SENSITIVE_PATTERNS.some(pattern => pattern.test(query.normalize("NFKC")));
}

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function fingerprint(key: string, accountId: string, query: string): Promise<string> {
  const encoder = new TextEncoder();
  const signingKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", signingKey,
    encoder.encode(JSON.stringify(["nfc-trim-v1", accountId, query.normalize("NFC").trim()])));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function makeObservation(
  env: ObservationEnv, ticket: ObservationTicket, query: string, available: Hit[], response: ToolResponse,
): Promise<SearchObservation> {
  const result = response.result as { content: { type: string; text: string }[] };
  const returned: Hit[] = JSON.parse(result.content[0].text);
  const indexed = new Map(available.map(hit => [hit.id, hit]));
  const hits = await Promise.all(returned.map(async (hit, index) => {
    const original = indexed.get(hit.id);
    if (!original) throw new Error("observation_snapshot_mismatch");
    return {
      id: hit.id, rank: index + 1,
      sourceRef: await digest(JSON.stringify([original.source ?? null, original.filename ?? null])),
      indexedContentHash: original.indexed_content_hash ?? null,
      retrievedContentHash: await digest(original.content),
      returnedContentHash: await digest(hit.content),
      returnedParentHash: hit.parent_content === undefined ? null : await digest(hit.parent_content),
      excerpted: hit.content !== original.content || hit.parent_content !== original.parent_content
        || (original.indexed_content_hash !== undefined && original.indexed_content_hash !== await digest(hit.content)),
    };
  }));
  const disposition = ticket.mode === "private" ? "private" : ticket.textDays === null ? "disabled"
    : mayRetainQueryText(query) ? "retained" : "filtered";
  return {
    id: ticket.id, accountId: ticket.accountId, mode: ticket.mode, observedAt: ticket.observedAt,
    queryFingerprint: await fingerprint(env.RETRIEVAL_OBSERVATION_HMAC_KEY!, ticket.accountId, query),
    queryText: disposition === "retained" ? query : null,
    textExpiresAt: disposition === "retained"
      ? new Date(Date.parse(ticket.observedAt) + ticket.textDays! * 86_400_000).toISOString() : null,
    textDisposition: disposition, workerVersion: env.CF_VERSION_METADATA?.id ?? null,
    snapshot: { version: 1, availableCount: available.length, returnedCount: hits.length,
      omittedHits: hits.length < available.length, hits },
  };
}

/** Never log driver errors: their detail can contain a rejected row or query text. */
function reportFailure(): void { console.warn("[retrieval-observations] operation_failed"); }

async function withObservationAccount<T>(
  env: ObservationEnv, accountId: string, fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = new Pool({ connectionString: env.RETRIEVAL_OBSERVATION_DATABASE_URL,
    max: 1, connectionTimeoutMillis: 2_000, query_timeout: 2_000 });
  pool.on("error", reportFailure);
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '2000ms'");
    const role = await client.query<{ unsafe: boolean }>(`
      SELECT r.rolsuper OR r.rolbypassrls OR pg_has_role(current_user, c.relowner, 'MEMBER') AS unsafe
      FROM pg_roles r CROSS JOIN pg_class c
      WHERE r.rolname = current_user AND c.oid = 'retrieval.observation'::regclass`);
    if (role.rows.length !== 1 || role.rows[0].unsafe) throw new Error("observation_role_not_isolated");
    await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(reportFailure);
    throw error;
  } finally {
    client?.release();
    await pool.end().catch(reportFailure);
  }
}

export async function insertObservation(env: ObservationEnv, event: SearchObservation): Promise<void> {
  await withObservationAccount(env, event.accountId, async client => {
    await client.query(`INSERT INTO retrieval.observation
      (account_id, id, mode, observed_at, query_fingerprint, query_text, text_expires_at,
       text_disposition, worker_version, snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT (account_id,id) DO NOTHING`,
    [event.accountId, event.id, event.mode, event.observedAt, event.queryFingerprint,
      event.queryText, event.textExpiresAt, event.textDisposition, event.workerVersion, JSON.stringify(event.snapshot)]);
  });
}

/** Best effort: returning an ID means scheduled, not durably committed. */
export function enqueueObservation(
  env: ObservationEnv, ticket: ObservationTicket | undefined, query: string, available: Hit[], response: ToolResponse,
): void {
  if (!ticket) return;
  const task = makeObservation(env, ticket, query, available, response)
    .then(event => insertObservation(env, event)).catch(reportFailure);
  try { ticket.runtime.waitUntil(task); } catch { reportFailure(); }
}

export async function recordObservationFeedback(
  env: ObservationEnv, runtime: ObservationRuntime | undefined,
  args: { observation_id?: unknown; document_id?: unknown; helpfulness?: unknown; cited?: unknown },
): Promise<{ recorded: boolean; reason?: string }> {
  const accountId = admittedAccount(env, runtime);
  if (!accountId) return { recorded: false, reason: "observation_unavailable" };
  if (typeof args.observation_id !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(args.observation_id)
    || !Number.isSafeInteger(args.document_id) || typeof args.helpfulness !== "boolean"
    || (args.cited !== undefined && typeof args.cited !== "boolean")) {
    return { recorded: false, reason: "invalid_observation_feedback" };
  }
  try {
    return await withObservationAccount(env, accountId, async client => {
      const inserted = await client.query(`INSERT INTO retrieval.citation_feedback
        (account_id, observation_id, document_id, helpfulness, cited)
        SELECT account_id, id, $3, $4, $5 FROM retrieval.observation
        WHERE account_id = $1 AND id = $2 AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(snapshot->'hits') h WHERE (h->>'id')::bigint = $3)
        ON CONFLICT (account_id, observation_id, document_id) DO UPDATE
          SET helpfulness = EXCLUDED.helpfulness, cited = COALESCE(EXCLUDED.cited, retrieval.citation_feedback.cited), updated_at = now()
        RETURNING observation_id`, [accountId, args.observation_id, args.document_id, args.helpfulness, args.cited ?? null]);
      return inserted.rowCount ? { recorded: true } : { recorded: false, reason: "observation_or_hit_unavailable_retry" };
    });
  } catch { reportFailure(); return { recorded: false, reason: "observation_unavailable" }; }
}

/** Narrow maintenance function: deletes expired records and their feedback,
 * and scrubs text when a shorter text-only window was configured. */
export async function expireObservations(env: ObservationEnv): Promise<void> {
  if (!env.RETRIEVAL_OBSERVATION_DATABASE_URL) return;
  try {
    await withObservationAccount(env, "", async client => {
      await client.query("SELECT retrieval.expire_observations()");
    });
  } catch { reportFailure(); }
}

/** Private administrative CLI calls this only after verifying the caller's JWT.
 * These are candidate examples, not a labelled evaluation dataset or sharing consent.
 */
export async function exportOwnObservations(env: ObservationEnv, verifiedAccountId: string): Promise<unknown[]> {
  if (!verifiedAccountId || !env.RETRIEVAL_OBSERVATION_DATABASE_URL) throw new Error("export_unavailable");
  return withObservationAccount(env, verifiedAccountId, async client => {
    const result = await client.query(`
      SELECT o.id, o.observed_at, o.expires_at, o.query_text, o.query_fingerprint, o.fingerprint_version,
        o.worker_version, o.snapshot,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('document_id', f.document_id,
          'helpfulness', f.helpfulness, 'cited', f.cited) ORDER BY f.document_id)
          FROM retrieval.citation_feedback f WHERE f.account_id = $1 AND f.observation_id = o.id), '[]'::jsonb) AS feedback
      FROM (SELECT DISTINCT ON (query_fingerprint) * FROM retrieval.observation_export
        WHERE account_id = $1 AND mode = 'public' AND query_text IS NOT NULL
        ORDER BY query_fingerprint, observed_at DESC, id DESC) o
      ORDER BY o.observed_at DESC, o.id DESC LIMIT 1000`, [verifiedAccountId]);
    return result.rows;
  });
}
