/**
 * RLS context wrapper — WP-212 B4.22-2
 *
 * Устанавливает канонический RLS-ключ и временно зеркалит legacy-имена внутри транзакции
 * (WP-515 Ф2, мост Варианта Б). RLS-политики читают current_user_id() = current_setting('app.user_id', true)
 * до перевода на app.account_id.
 *
 * Использование:
 *   const results = await withUserContext(env.DATABASE_URL, userId, async (sql) => {
 *     return sql`SELECT * FROM documents WHERE ...`;
 *   });
 *
 * Гарантии:
 *   - SET LOCAL действует только внутри транзакции — при COMMIT/ROLLBACK сбрасывается
 *   - Соединение возвращается в пул с чистым состоянием
 *   - Если userId = null/undefined — SET LOCAL не вызывается → RLS блокирует личные данные
 *
 * Pool lifecycle (issue #231, root-caused 2026-07-10 via live `wrangler tail`): a Pool
 * must never outlive the request that created it. Two things were tried and rejected
 * before landing here:
 *   1. A single Pool singleton shared across ALL worker requests (the original code) —
 *      confirmed via live trace to throw "Cannot perform I/O on behalf of a different
 *      request": Cloudflare Workers ties a Pool's underlying connection to the IoContext
 *      of the request that opened it, and kills any later, unrelated request that reuses
 *      it through the shared singleton. This was the actual source of den317's ~30%
 *      "Backend error: 500" reports.
 *   2. A brand new Pool per withUserContext() call — safe, but every one of
 *      searchDocuments()'s 2-4 sequential DB round-trips then paid its own fresh
 *      WebSocket handshake, pushing every search from single-digit ms to 18-22s.
 * Landed: withUserContext() takes an optional caller-supplied Pool (see
 * createRequestPool() below) so a single request that needs several round-trips (e.g.
 * search) can share one Pool for its own duration, while single-call sites still get a
 * pool created and torn down just for them. Either way, no Pool is ever reused across
 * two different incoming requests.
 *
 * Pool is also an EventEmitter: `emit('error')` with no listener throws, so an idle
 * connection dropped by the network between connect() and release() used to crash the
 * worker outright instead of logging. createRequestPool() attaches a listener so that
 * can't happen either.
 */

import { neonConfig, Pool } from "@neondatabase/serverless";

// Cloudflare Workers: использовать нативный WebSocket (доступен через nodejs_compat)
// Без этого Pool не может открыть WebSocket-соединение для транзакций
if (typeof WebSocket !== "undefined") {
  neonConfig.webSocketConstructor = WebSocket;
}

/**
 * Create a Pool for a single incoming request. Caller owns its lifecycle: pass it to
 * every withUserContext() call needed to serve that one request, then `await pool.end()`
 * in a finally block. Never store the result outside the request that created it.
 */
export function createRequestPool(connectionString: string): Pool {
  const pool = new Pool({ connectionString, max: 5 });
  pool.on("error", (err: Error) => {
    console.error("[rls] pool error on idle client (contained):", err);
  });
  return pool;
}

// WP-515 Ф2: канонический ключ и временный мост к прежним соглашениям.
// Порядок = порядок применения (первый пишется первым); RLS-политики читают
// имена независимо, порядок set_config между собой не важен для них.
const RLS_ACCOUNT_CONTEXT_GUCS = [
  "app.account_id",
  "app.current_account_id",
  "app.user_id",
  "app.current_user_id",
  "app.current_user_identity",
] as const;

type IdentifierMarker = { __identifier: string };

type SqlClient = {
  // Tagged template: sql`SELECT ...`
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  // Identifier injection: sql("schema.table") → marker for safe quoting
  (identifier: string): IdentifierMarker;
  // Raw identifier interpolation (neon compatibility)
  unsafe: (identifier: string) => IdentifierMarker;
};

/**
 * Выполнить callback внутри транзакции с установленным каноническим RLS-контекстом
 * и временным зеркалированием legacy-имён (WP-515 Ф2).
 *
 * @param connectionString - DATABASE_URL
 * @param userId - Ory user UUID (или null для платформенных запросов)
 * @param fn - async функция, получающая тегированный шаблон sql
 * @param sharedPool - опционально: пул, созданный и закрываемый вызывающей стороной
 *   (см. createRequestPool) — для нескольких последовательных вызовов в рамках одного
 *   запроса. Без него функция сама создаёт и закрывает пул на один этот вызов.
 */
export async function withUserContext<T>(
  connectionString: string,
  userId: string | null | undefined,
  fn: (sql: SqlClient) => Promise<T>,
  sharedPool?: Pool
): Promise<T> {
  const pool = sharedPool ?? createRequestPool(connectionString);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (userId) {
      // set_config с is_local=true — эквивалент SET LOCAL, но принимает параметр
      // SET LOCAL не поддерживает $1 параметры в протоколе PostgreSQL
      for (const gucName of RLS_ACCOUNT_CONTEXT_GUCS) {
        await client.query(`SELECT set_config('${gucName}', $1, true)`, [userId]);
      }
    }

    // Обёртка для совместимости с кодом использующим тегированный шаблон.
    // Поддерживает identifier injection: sql("schema.table") → маркер для безопасного цитирования.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sql = ((stringsOrName: TemplateStringsArray | string, ...values: unknown[]): any => {
      // Вызов как обычная функция sql("schema.table") — identifier injection
      if (typeof stringsOrName === "string") {
        return { __identifier: stringsOrName } as IdentifierMarker;
      }
      // Вызов как тегированный шаблон sql`SELECT ...`
      let query = "";
      const params: unknown[] = [];
      stringsOrName.forEach((str, i) => {
        query += str;
        if (i < values.length) {
          const v = values[i];
          if (v !== null && typeof v === "object" && "__identifier" in (v as object)) {
            // Inline quoted identifier: "schema"."table"
            const id = (v as IdentifierMarker).__identifier;
            query += id.split(".").map((s) => `"${s.replace(/"/g, '""')}"`).join(".");
          } else {
            params.push(v);
            query += `$${params.length}`;
          }
        }
      });
      return client.query(query, params).then((r) => r.rows);
    }) as SqlClient;

    // Compatibility with neon()'s sql.unsafe() — used throughout index.ts
    (sql as any).unsafe = (identifier: string): IdentifierMarker => {
      return { __identifier: identifier };
    };

    const result = await fn(sql);

    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    if (!sharedPool) {
      await pool.end().catch((err) => {
        console.error("[rls] pool.end() failed (contained):", err);
      });
    }
  }
}
