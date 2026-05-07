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

type IdentifierMarker = { __identifier: string };

type SqlClient = {
  // Tagged template: sql`SELECT ...`
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  // Identifier injection: sql("schema.table") → marker for safe quoting
  (identifier: string): IdentifierMarker;
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
      // set_config с is_local=true — эквивалент SET LOCAL, но принимает параметр
      // SET LOCAL не поддерживает $1 параметры в протоколе PostgreSQL
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
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
