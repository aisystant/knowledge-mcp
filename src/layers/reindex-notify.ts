/**
 * Operator notice about a finished reindex job (WP-545 Ф23). One best-effort Telegram message,
 * one attempt with a short timeout; a lost message is accepted until the reliable-delivery
 * phase (Ф24). Silent by design for routine outcomes: an incremental (push-triggered) job that
 * succeeded is not reported, every failure and every full-rebuild success is.
 * The text carries the source name only, never a user identity.
 *
 * Notification Center (WP-568 Ф10): every failure is also written to the operator's
 * Notification Center (Grafana Cloud Loki, same stream shape as notification-center-send.sh),
 * which counts it instead of interrupting the chat. Telegram and the Center run side by side
 * until the dual-write check passes; then the Telegram variables are removed. A source that
 * does not belong to the operator is shown in the Center without its name.
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

export function shouldNotify(job: Pick<FinishedJob, "status" | "kind">): boolean {
  return job.status === "failed" || job.kind === "full";
}

export function renderNotice(job: FinishedJob): string {
  const kind = job.kind === "full" ? "Полная" : "Инкрементальная";
  if (job.status === "succeeded") return `${kind} переиндексация источника ${job.source} завершена.`;
  const reason = (job.reason ?? "причина не записана").slice(0, MAX_REASON_CHARS);
  const more = job.errorCount && job.errorCount > 1 ? ` (и ещё ошибок: ${job.errorCount - 1})` : "";
  return `${kind} переиндексация источника ${job.source} не удалась: ${reason}${more}`;
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
export function renderCenterEvent(job: FinishedJob, operatorUserId?: string): CenterEvent | null {
  if (job.status !== "failed") return null;
  const operator = operatorUserId?.trim();
  const own = Boolean(operator) && job.userId === operator;
  const name = own ? job.source : FOREIGN_SOURCE;
  const reason = own ? (job.reason ?? "причина не записана").slice(0, MAX_REASON_CHARS) : reasonCategory(job.reason);
  const kind = job.kind === "full" ? "Полная" : "Инкрементальная";
  const more = job.errorCount && job.errorCount > 1 ? ` (и ещё ошибок: ${job.errorCount - 1})` : "";
  return {
    title: `${kind} переиндексация не удалась: ${name}`,
    detail: `${reason}${more}`,
    // Same failure of the same source within the alert window is one Center item, not many.
    correlationId: `${CENTER_SOURCE}:${job.kind}:${name}`,
  };
}

/** First recorded error as text; the errors column holds strings or small JSON objects. */
export function firstErrorText(errors: unknown): string | undefined {
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const first = errors[0];
  return typeof first === "string" ? first : JSON.stringify(first);
}

async function sendTelegram(env: ReindexNotifyEnv, job: FinishedJob): Promise<void> {
  if (!shouldNotify(job)) return;
  const { REINDEX_NOTIFY_TELEGRAM_TOKEN: token, REINDEX_NOTIFY_CHAT_ID: chatId } = env;
  if (!token || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: renderNotice(job) }),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!res.ok) console.warn(JSON.stringify({ phase: "notify_failed", http_status: res.status, source: job.source }));
  } catch (err) {
    // Never the token: the URL carries it, so only the error class and message of the abort/network failure.
    console.warn(JSON.stringify({ phase: "notify_failed", source: job.source, error: err instanceof Error ? err.name : "unknown" }));
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
    const event = renderCenterEvent(job, env.REINDEX_OPERATOR_USER_ID);
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
