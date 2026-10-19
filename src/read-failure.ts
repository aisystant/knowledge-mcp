/** Safe diagnostics for read dependencies. Never retain upstream bodies, URLs or credentials. */
export type ReadStage = "context" | "database" | "github_token" | "github_content" | "embeddings" | "reranking";
export type ReadFailureCode =
  | "source_context_unavailable"
  | "github_not_connected"
  | "dependency_access_denied"
  | "dependency_rate_limited"
  | "dependency_unavailable"
  | "dependency_timeout"
  | "dependency_invalid_response";

const MESSAGES: Record<ReadFailureCode, string> = {
  source_context_unavailable: "Не удалось проверить доступные источники. Это не означает, что файлы отсутствуют. Повтори запрос позже.",
  github_not_connected: "Не удалось получить доступ к GitHub. Проверь подключение репозитория.",
  dependency_access_denied: "Сервис отклонил доступ. Проверь подключение; повтор того же запроса не восстановит права.",
  dependency_rate_limited: "Сервис ограничил частоту запросов. Повтори позже, учитывая retry_after_seconds, если он указан.",
  dependency_unavailable: "Сервис временно недоступен. Повтори запрос позже; файл не объявлен отсутствующим.",
  dependency_timeout: "Сервис не завершил чтение вовремя. Повтори запрос позже; файл не объявлен отсутствующим.",
  dependency_invalid_response: "Сервис вернул неподдерживаемый или повреждённый ответ. Содержимое файла не получено.",
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
      retryable: ["source_context_unavailable", "dependency_rate_limited", "dependency_unavailable", "dependency_timeout"].includes(this.code),
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
  run<T>(stage: ReadTraceStage, operation: () => Promise<T>): Promise<T>;
}

/** Correlate dependency stages without accepting caller IDs, queries, paths, or payloads. */
export function createReadTrace(operation: ReadOperation): ReadTrace {
  const traceId = crypto.randomUUID();
  return {
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
