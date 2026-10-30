/**
 * Operator notice about a finished reindex job (WP-545 Ф23). One best-effort Telegram message,
 * one attempt with a short timeout; a lost message is accepted until the reliable-delivery
 * phase (Ф24). Silent by design for routine outcomes: an incremental (push-triggered) job that
 * succeeded is not reported, every failure and every full-rebuild success is.
 * The text carries the source name only, never a user identity.
 */

const NOTIFY_TIMEOUT_MS = 4000;
const MAX_REASON_CHARS = 200;

export interface ReindexNotifyEnv {
  /** Telegram bot token of the operator channel. Notices are off while this or the chat id is unset. */
  REINDEX_NOTIFY_TELEGRAM_TOKEN?: string;
  REINDEX_NOTIFY_CHAT_ID?: string;
}

export interface FinishedJob {
  status: "succeeded" | "failed";
  kind: "full" | "incremental";
  source: string;
  reason?: string;
}

export function shouldNotify(job: Pick<FinishedJob, "status" | "kind">): boolean {
  return job.status === "failed" || job.kind === "full";
}

export function renderNotice(job: FinishedJob): string {
  const kind = job.kind === "full" ? "Полная" : "Инкрементальная";
  if (job.status === "succeeded") return `${kind} переиндексация источника ${job.source} завершена.`;
  const reason = (job.reason ?? "причина не записана").slice(0, MAX_REASON_CHARS);
  return `${kind} переиндексация источника ${job.source} не удалась: ${reason}`;
}

/** First recorded error as text; the errors column holds strings or small JSON objects. */
export function firstErrorText(errors: unknown): string | undefined {
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const first = errors[0];
  return typeof first === "string" ? first : JSON.stringify(first);
}

export async function notifyJobFinished(env: ReindexNotifyEnv, job: FinishedJob): Promise<void> {
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
