/**
 * Operator notice about a finished reindex job (WP-545 Ф23). One best-effort Telegram message,
 * one attempt with a short timeout; a lost message is accepted until the reliable-delivery
 * phase (Ф24). Only failures are reported: a success needs no action from the operator
 * (WP-568 Ф10, 10.11 — full-rebuild successes no longer reach the chat).
 *
 * Notification Center (WP-568 Ф10): every failure is also written to the operator's
 * Notification Center (Grafana Cloud Loki, same stream shape as notification-center-send.sh).
 * Telegram and the Center run side by side until the operator actually reads the Center; then
 * the Telegram variables are removed. Both channels render the same failure text: a source that
 * does not belong to the operator is shown without its name (it often carries a GitHub login)
 * and with a fixed cause category instead of the free error text.
 */

const NOTIFY_TIMEOUT_MS = 4000;
const MAX_REASON_CHARS = 200;
const CENTER_SOURCE = "knowledge-reindex";
const FOREIGN_SOURCE = "источник другого пользователя";

export interface ReindexNotifyEnv {
  /** Telegram bot token of the operator channel. Notices are off while this or the chat id is unset. */
  REINDEX_NOTIFY_TELEGRAM_TOKEN?: string;
  REINDEX_NOTIFY_CHAT_ID?: string;
  /** Loki host of the Notification Center, e.g. https://logs-prod-012.grafana.net. Center writes are off while any of the three is unset. */
  REINDEX_CENTER_LOKI_URL?: string;
  REINDEX_CENTER_LOKI_USER?: string;
  /** Grafana Cloud access policy token with logs:write. */
  REINDEX_CENTER_LOKI_TOKEN?: string;
  /** Ory identity of the operator; only this user's sources keep their name in the Center. */
  REINDEX_OPERATOR_USER_ID?: string;
}

export interface FinishedJob {
  status: "succeeded" | "failed";
  kind: "full" | "incremental";
  source: string;
  /** Owner of the source; decides whether the Center may show the source name. */
  userId?: string;
  reason?: string;
  /** How many errors the job recorded; the notice names the first and counts the rest (WP-607). */
  errorCount?: number;
}

export interface CenterEvent {
  title: string;
  detail: string;
  correlationId: string;
}

export function shouldNotify(job: Pick<FinishedJob, "status">): boolean {
  return job.status === "failed";
}

interface FailureParts {
  kind: string;
  own: boolean;
  name: string;
  reason: string;
}

/** Failure wording shared by Telegram and the Center; another user's source loses its name and free text. */
function failureParts(job: FinishedJob, operatorUserId?: string): FailureParts {
  const operator = operatorUserId?.trim();
  const own = Boolean(operator) && job.userId === operator;
  const more = job.errorCount && job.errorCount > 1 ? ` (и ещё ошибок: ${job.errorCount - 1})` : "";
  return {
    kind: job.kind === "full" ? "Полная" : "Инкрементальная",
    own,
    name: own ? job.source : FOREIGN_SOURCE,
    reason: (own ? (job.reason ?? "причина не записана").slice(0, MAX_REASON_CHARS) : reasonCategory(job.reason)) + more,
  };
}

/** Telegram text for a failed job, or null: successes are not reported. */
export function renderNotice(job: FinishedJob, operatorUserId?: string): string | null {
  if (!shouldNotify(job)) return null;
  const { kind, own, name, reason } = failureParts(job, operatorUserId);
  const subject = own ? `источника ${name}` : "источника другого пользователя";
  return `${kind} переиндексация ${subject} не удалась: ${reason}`;
}

const WATCHDOG_REASONS = new Set([
  "задача так и не стартовала",
  "все пакеты обработаны, но итог не записан",
  "задача зависла, пакеты перестали обрабатываться",
]);

/**
 * Fixed cause category for a job of another user. Error texts carry the user's other source
 * names, file paths, the user id and raw driver messages, so none of the free text is passed on;
 * only the GitHub failure code (a closed set of machine values) is kept.
 */
export function reasonCategory(reason: string | undefined): string {
  if (reason === undefined) return "причина не записана";
  const read = /^Cannot read .* from GitHub \(([a-z0-9_]+)\)$/.exec(reason);
  if (read) return `не удалось прочитать файл из GitHub (${read[1]})`;
  if (reason.startsWith("Cannot enumerate repository")) return "не удалось получить список файлов репозитория";
  if (reason.startsWith("Unknown source")) return "источник не найден у пользователя";
  if (reason.startsWith("Invalid user context") || reason.startsWith("Missing user_id")) return "неверный контекст пользователя";
  if (reason.startsWith("Missing job identity")) return "у задачи нет идентификатора, нужен новый запуск";
  if (WATCHDOG_REASONS.has(reason)) return reason;
  if (reason.includes("watchdog_stale_heartbeat")) return "задача зависла, пакеты перестали обрабатываться";
  if (reason.includes("watchdog_pending_never_started")) return "задача так и не стартовала";
  return "внутренняя ошибка, подробности в журнале сервера";
}

/** Center event for a failed job, or null: successes are not faults and are not counted. */
export function renderCenterEvent(job: FinishedJob, operatorUserId?: string, foreignKey?: string): CenterEvent | null {
  if (!shouldNotify(job)) return null;
  const { kind, own, name, reason } = failureParts(job, operatorUserId);
  // Foreign sources share one masked name; the pseudonymous key keeps them apart, so the Center
  // and the digest can count distinct sources and repeated failures of one source (WP-568 Ф10, 13.11).
  const key = !own && foreignKey ? `:${foreignKey}` : "";
  return {
    title: `${kind} переиндексация не удалась: ${name}`,
    detail: reason,
    // Same failure of the same source within the alert window is one Center item, not many.
    correlationId: `${CENTER_SOURCE}:${job.kind}:${name}${key}`,
  };
}

/**
 * Stable pseudonym of another user's source: 8 hex of SHA-256 over user id and source name.
 * The user id is a random UUID, so the key cannot be reversed to a name by guessing logins.
 */
export async function foreignSourceKey(job: Pick<FinishedJob, "userId" | "source">): Promise<string> {
  const data = new TextEncoder().encode(`${job.userId ?? ""}\u0000${job.source}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** First recorded error as text; the errors column holds strings or small JSON objects. */
export function firstErrorText(errors: unknown): string | undefined {
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const first = errors[0];
  return typeof first === "string" ? first : JSON.stringify(first);
}

async function sendTelegram(env: ReindexNotifyEnv, job: FinishedJob): Promise<void> {
  const text = renderNotice(job, env.REINDEX_OPERATOR_USER_ID);
  if (text === null) return;
  // The worker log gets the same masked name as the chat: a foreign source name often carries a GitHub login.
  const source = failureParts(job, env.REINDEX_OPERATOR_USER_ID).name;
  const { REINDEX_NOTIFY_TELEGRAM_TOKEN: token, REINDEX_NOTIFY_CHAT_ID: chatId } = env;
  if (!token || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!res.ok) console.warn(JSON.stringify({ phase: "notify_failed", http_status: res.status, source }));
  } catch (err) {
    // Never the token: the URL carries it, so only the error class and message of the abort/network failure.
    console.warn(JSON.stringify({ phase: "notify_failed", source, error: err instanceof Error ? err.name : "unknown" }));
  }
}

// Workers freeze Date.now() between I/O calls, and Loki drops a line that repeats the timestamp and
// text of another line in the same stream: a per-isolate sequence fills the sub-millisecond digits.
let centerSeq = 0;

function lokiTimestamp(): string {
  centerSeq = (centerSeq + 1) % 1_000_000;
  return `${Date.now()}${String(centerSeq).padStart(6, "0")}`;
}

async function writeCenter(env: ReindexNotifyEnv, job: FinishedJob): Promise<void> {
  const { REINDEX_CENTER_LOKI_URL: url, REINDEX_CENTER_LOKI_USER: user, REINDEX_CENTER_LOKI_TOKEN: token } = env;
  if (!url || !user || !token) return;
  // Everything inside the try: the caller has already committed the job status and must not fail here.
  try {
    const event = renderCenterEvent(job, env.REINDEX_OPERATOR_USER_ID, await foreignSourceKey(job));
    if (!event) return;
    const line = JSON.stringify({
      schema_version: 1,
      event: "notification",
      title: event.title,
      detail: event.detail,
      correlation_id: event.correlationId,
    });
    const body = JSON.stringify({
      streams: [{
        stream: { job: "notification-center", source: CENTER_SOURCE, severity: "warning", needs_decision: "false" },
        values: [[lokiTimestamp(), line]],
      }],
    });
    const base = url.replace(/\/+$/, "").replace(/\/loki\/api\/v1\/push$/, "");
    const res = await fetch(`${base}/loki/api/v1/push`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${btoa(`${user}:${token}`)}` },
      body,
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!res.ok) console.warn(JSON.stringify({ phase: "center_write_failed", http_status: res.status }));
  } catch (err) {
    // The authorization header carries the token; log only the error class.
    console.warn(JSON.stringify({ phase: "center_write_failed", error: err instanceof Error ? err.name : "unknown" }));
  }
}

export async function notifyJobFinished(env: ReindexNotifyEnv, job: FinishedJob): Promise<void> {
  // Independent channels: a slow or failing one must not cost the other its single attempt or reject the caller.
  await Promise.allSettled([sendTelegram(env, job), writeCenter(env, job)]);
}
