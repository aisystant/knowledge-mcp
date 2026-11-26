/** Safe diagnostics for read dependencies. Never retain upstream bodies, URLs or credentials. */
export type ReadStage = "context" | "database" | "github_token" | "github_content" | "embeddings" | "reranking";
export type ReadFailureCode =
  | "source_context_unavailable"
  | "github_not_connected"
  | "dependency_access_denied"
  | "dependency_input_rejected"
  | "dependency_quota_exhausted"
  | "dependency_rate_limited"
  | "dependency_unavailable"
  | "dependency_timeout"
  | "dependency_invalid_response";

const MESSAGES: Record<ReadFailureCode, string> = {
  source_context_unavailable: "Не удалось проверить доступные источники. Это не означает, что файлы отсутствуют. Повтори запрос позже.",
  github_not_connected: "Не удалось получить доступ к GitHub. Проверь подключение репозитория.",
  dependency_access_denied: "Сервис отклонил доступ. Проверь подключение; повтор того же запроса не восстановит права.",
  dependency_input_rejected: "Внешний сервис смыслового поиска не принял текст этого запроса (проверка содержания). Доступ к источникам в порядке: переформулируй запрос другими словами.",
  dependency_quota_exhausted: "У платформы временно исчерпан лимит сервиса смыслового поиска. Доступ пользователя в порядке; повтори запрос позже.",
  dependency_rate_limited: "Сервис ограничил частоту запросов. Повтори позже, учитывая retry_after_seconds, если он указан.",
  dependency_unavailable: "Сервис временно недоступен. Повтори запрос позже; файл не объявлен отсутствующим.",
  dependency_timeout: "Сервис не завершил чтение вовремя. Повтори запрос позже; файл не объявлен отсутствующим.",
  dependency_invalid_response: "Сервис вернул неподдерживаемый или повреждённый ответ. Содержимое файла не получено.",
};

type ReadToolErrorCode = "auth" | "validation" | "upstream";

/**
 * WP-596 Ф4: every ReadFailure is a dependency problem, not a caller mistake — except
 * dependency_access_denied (the caller's own credentials/permissions are the blocker) and
 * dependency_input_rejected (WP-560 Ф23: the provider refused the query text itself, so the
 * caller fixes it by rewording, not by reconnecting).
 */
const TOOL_ERROR_CODES: Partial<Record<ReadFailureCode, ReadToolErrorCode>> = {
  dependency_access_denied: "auth",
  dependency_input_rejected: "validation",
};

export class ReadFailure extends Error {
  constructor(
    readonly code: ReadFailureCode,
    readonly stage: ReadStage,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(MESSAGES[code]);
    this.name = "ReadFailure";
  }

  toJSON() {
    return {
      error: this.code,
      stage: this.stage,
      message: this.message,
      retryable: ["source_context_unavailable", "dependency_quota_exhausted", "dependency_rate_limited", "dependency_unavailable", "dependency_timeout"].includes(this.code),
      error_code: TOOL_ERROR_CODES[this.code] ?? ("upstream" as ReadToolErrorCode),
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.retryAfterSeconds === undefined ? {} : { retry_after_seconds: this.retryAfterSeconds }),
    };
  }
}

type ReadOperation = "platform_search" | "personal_search" | "memory_search";
type ReadTraceStage =
  | "search" | "embedding" | "keyword" | "vector" | "rerank" | "parent_content" | "pool_close"
  | "db_connect" | "db_begin" | "db_context" | "db_query" | "db_commit" | "db_rollback";

export interface ReadTrace {
  readonly id: string;
  run<T>(stage: ReadTraceStage, operation: () => Promise<T>): Promise<T>;
}

/** Correlate dependency stages without accepting caller IDs, queries, paths, or payloads. */
export function createReadTrace(operation: ReadOperation): ReadTrace {
  const traceId = crypto.randomUUID();
  return {
    id: traceId,
    async run<T>(stage: ReadTraceStage, work: () => Promise<T>): Promise<T> {
      const fields = { event: "read_stage", trace_id: traceId, operation, stage };
      const started = performance.now();
      console.info(JSON.stringify({ ...fields, phase: "start" }));
      try {
        const result = await work();
        console.info(JSON.stringify({ ...fields, phase: "end", outcome: "success", elapsed_ms: Math.max(0, Math.round(performance.now() - started)) }));
        return result;
      } catch (error) {
        console.info(JSON.stringify({ ...fields, phase: "end", outcome: "error", elapsed_ms: Math.max(0, Math.round(performance.now() - started)), error_kind: error instanceof ReadFailure ? error.code : "unclassified" }));
        throw error;
      }
    },
  };
}

function retryAfterSeconds(response: Response): number | undefined {
  const after = response.headers?.get?.("retry-after");
  const reset = response.headers?.get?.("x-ratelimit-reset");
  const seconds = after
    ? (/^\d+$/.test(after) ? Number(after) : Math.ceil((Date.parse(after) - Date.now()) / 1000))
    : (reset && /^\d+$/.test(reset) ? Math.ceil(Number(reset) - Date.now() / 1000) : NaN);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

export function readHttpFailure(response: Response, stage: ReadStage): ReadFailure {
  const rateLimited = response.status === 429 || (response.status === 403 && (
    response.headers?.get?.("x-ratelimit-remaining") === "0"
    || response.headers?.get?.("retry-after") != null
  ));
  const code = rateLimited ? "dependency_rate_limited"
    : response.status === 401 || response.status === 403 ? "dependency_access_denied"
    : response.status >= 500 ? "dependency_unavailable"
    : "dependency_invalid_response";
  return new ReadFailure(code, stage, response.status, rateLimited ? retryAfterSeconds(response) : undefined);
}

/** Closed set of refusal reasons; only these words ever reach the log, never provider text. */
export type ProviderRefusalReason = "input_flagged" | "key_limit" | "other";

const PROVIDER_BODY_LIMIT = 4_096;

/**
 * WP-560 Ф23: OpenRouter answers 403 both for "your input was flagged" (moderation of the
 * query text) and for "key limit exceeded" (the platform's spend cap). Before this, both
 * became dependency_access_denied with error_code "auth", and a participant's agent asked to
 * "restore access" (21.11). The body is read only to pick a reason from a closed set.
 */
export function classifyProviderRefusal(body: string): ProviderRefusalReason {
  let parsed: { error?: { message?: unknown; metadata?: { reasons?: unknown } } } | undefined;
  try { parsed = JSON.parse(body); } catch { return "other"; }
  const error = parsed?.error;
  if (Array.isArray(error?.metadata?.reasons)) return "input_flagged";
  const message = typeof error?.message === "string" ? error.message : "";
  if (/flagged|moderation/i.test(message)) return "input_flagged";
  if (/limit|credit/i.test(message)) return "key_limit";
  return "other";
}

// An unreadable body is not an error of its own: the refusal is then logged with reason "other".
interface ProviderBody { text: string; length: number; truncated: boolean; unreadable: boolean }

async function boundedBody(response: Response): Promise<ProviderBody> {
  try {
    const text = await response.text();
    return { text: text.slice(0, PROVIDER_BODY_LIMIT), length: text.length, truncated: text.length > PROVIDER_BODY_LIMIT, unreadable: false };
  } catch {
    return { text: "", length: 0, truncated: false, unreadable: true };
  }
}

// snake_case only: a free-form word from the provider could carry a fragment of the query or a key id.
const SAFE_PROVIDER_CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;
// Closed list of metadata key names that may be reported (names only, never values).
const KNOWN_METADATA_KEYS = ["reasons", "provider_name", "raw", "flagged_input", "model_slug"] as const;

type ProviderBodyShape = "empty" | "unreadable" | "truncated" | "not_json" | "json_no_error" | "json_error";

export interface ProviderRefusalShape {
  body_shape: ProviderBodyShape;
  body_length: number;
  content_type: "json" | "html" | "other";
  provider_code: string | null;
  metadata_keys: string[];
  edge_block: boolean;
}

/**
 * WP-560 Ф23: reason "other" alone cannot tell an HTML block page, an empty body, a cut-off body
 * and an unfamiliar JSON error apart. Only closed-set values, numbers and snake_case codes
 * are returned: never the provider's message, the query text or any metadata value.
 */
export function describeProviderRefusal(response: Response, body: ProviderBody): ProviderRefusalShape {
  const contentType = response.headers?.get?.("content-type") ?? "";
  const shape: ProviderRefusalShape = {
    body_shape: "empty",
    body_length: body.length,
    content_type: /json/i.test(contentType) ? "json" : /html/i.test(contentType) ? "html" : "other",
    provider_code: null,
    metadata_keys: [],
    edge_block: response.headers?.has?.("cf-mitigated") ?? false,
  };
  if (body.unreadable) return { ...shape, body_shape: "unreadable" };
  if (body.length === 0) return shape;
  if (body.truncated) return { ...shape, body_shape: "truncated" };
  let parsed: { error?: { code?: unknown; metadata?: unknown } } | null;
  try { parsed = JSON.parse(body.text); } catch { return { ...shape, body_shape: "not_json" }; }
  const error = parsed?.error;
  if (typeof error !== "object" || error === null) return { ...shape, body_shape: "json_no_error" };
  const code = error.code;
  const providerCode = typeof code === "number" && Number.isInteger(code) ? String(code)
    : typeof code === "string" && SAFE_PROVIDER_CODE_RE.test(code) ? code : null;
  const metadata = typeof error.metadata === "object" && error.metadata !== null ? error.metadata : {};
  return {
    ...shape,
    body_shape: "json_error",
    provider_code: providerCode,
    metadata_keys: KNOWN_METADATA_KEYS.filter(key => key in metadata),
  };
}

/** Embeddings-specific HTTP failure: tells a refused query text and a spent key apart from real access loss. */
export async function readEmbeddingsFailure(response: Response, traceId?: string): Promise<ReadFailure> {
  const generic = readHttpFailure(response, "embeddings");
  if (response.status !== 402 && generic.code !== "dependency_access_denied") return generic;
  // 402 already means "key limit": its body is not read, so a stalled body cannot turn it into a timeout.
  const body = response.status === 402 ? undefined : await boundedBody(response);
  const reason = body === undefined ? "key_limit" : classifyProviderRefusal(body.text);
  console.warn(JSON.stringify({
    event: "embeddings_refused", status: response.status, reason, ...(traceId ? { trace_id: traceId } : {}),
    ...(body ? describeProviderRefusal(response, body) : {}),
  }));
  if (reason === "input_flagged") return new ReadFailure("dependency_input_rejected", "embeddings", response.status);
  if (reason === "key_limit") return new ReadFailure("dependency_quota_exhausted", "embeddings", response.status);
  return generic;
}

/** Covers headers AND body; racing also bounds a dependency that ignores AbortSignal. */
export async function withReadDeadline<T>(
  stage: ReadStage,
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = 15_000,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ReadFailure("dependency_timeout", stage));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } catch (error) {
    if (error instanceof ReadFailure) throw error;
    if (controller.signal.aborted) throw new ReadFailure("dependency_timeout", stage);
    throw new ReadFailure(stage === "context" ? "source_context_unavailable" : "dependency_unavailable", stage);
  } finally {
    clearTimeout(timer!);
  }
}

export async function fetchReadResponse(
  input: RequestInfo | URL,
  init: RequestInit,
  stage: ReadStage,
  signal: AbortSignal,
): Promise<Response> {
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(input, { ...init, signal });
  } catch {
    throw new ReadFailure(signal.aborted ? "dependency_timeout" : "dependency_unavailable", stage);
  }
  if (!response.ok) throw readHttpFailure(response, stage);
  return response;
}

export async function readJson(response: Response, stage: ReadStage): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ReadFailure("dependency_invalid_response", stage, response.status);
  }
}
