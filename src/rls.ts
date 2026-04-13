/**
 * RLS context wrapper — WP-212 B4.22-2
 *
 * Устанавливает SET LOCAL app.user_id внутри транзакции.
 * RLS-политики (migration 006) читают current_user_id() = current_setting('app.user_id', true).
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
 */

import { neonConfig, Pool } from "@neondatabase/serverless";

// Cloudflare Workers: использовать нативный WebSocket (доступен через nodejs_compat)
// Без этого Pool не может открыть WebSocket-соединение для транзакций
if (typeof WebSocket !== "undefined") {
  neonConfig.webSocketConstructor = WebSocket;
}

// Один пул на Worker instance (переиспользуется между запросами)
// Экспортируется для сброса в тестах
export let _pool: Pool | null = null;

export function getPool(connectionString: string): Pool {
  if (!_pool) {
    _pool = new Pool({ connectionString, max: 5 });
  }
  return _pool;

}

/** Только для тестов: сбросить синглтон пула */
export function _resetPool(): void {
  _pool = null;
}

type SqlClient = {
  // Минимальный интерфейс совместимый с neon() для передачи в функции поиска
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
};

/**
 * Выполнить callback внутри транзакции с установленным app.user_id.
 *
 * @param connectionString - DATABASE_URL
 * @param userId - Ory user UUID (или null для платформенных запросов)
 * @param fn - async функция, получающая тегированный шаблон sql
 */
export async function withUserContext<T>(
  connectionString: string,
  userId: string | null | undefined,
  fn: (sql: SqlClient) => Promise<T>
): Promise<T> {
  const pool = getPool(connectionString);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (userId) {
      // SET LOCAL — действует только до конца текущей транзакции
      await client.query("SET LOCAL app.user_id = $1", [userId]);
    }

    // Обёртка для совместимости с кодом использующим тегированный шаблон
    const sql = (<T = Record<string, unknown>>(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<T[]> => {
      // Собираем строку запроса с numbered placeholders ($1, $2, ...)
      let query = "";
      strings.forEach((str, i) => {
        query += str;
        if (i < values.length) query += `$${i + 1}`;
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return client.query(query, values as unknown[]).then((r) => r.rows as T[]);
    }) as SqlClient;

    const result = await fn(sql);

    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
