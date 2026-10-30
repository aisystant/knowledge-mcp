/**
 * Iterative HNSW scan settings for the platform vector query (WP-596 Ф10 п.12).
 *
 * The HNSW index returns `hnsw.ef_search` (40) nearest chunks and the query filters
 * (`source`, `account_id IS NULL`, denied sources) are applied AFTER that, so a narrow filter
 * can leave zero rows. pgvector >= 0.8 can keep scanning until enough rows pass the filters
 * (`hnsw.iterative_scan`). Everything is off by default; rollback = set VECTOR_ITERATIVE_SCAN=off
 * in the Worker environment. The environment is read on every call, never cached.
 */

export type VectorScanMode = "off" | "strict_order" | "relaxed_order";

export interface VectorScanEnv {
  VECTOR_ITERATIVE_SCAN?: string;
  VECTOR_MAX_SCAN_TUPLES?: string;
  VECTOR_STATEMENT_TIMEOUT_MS?: string;
}

export interface VectorScanConfig {
  mode: VectorScanMode;
  /** Unset keeps the pgvector default (20 000). */
  maxScanTuples?: number;
  /** Applied only when the scan is iterative; the slowest measured case was 235 ms. */
  statementTimeoutMs: number;
}

type TaggedSql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

const SCAN_MODES: readonly VectorScanMode[] = ["off", "strict_order", "relaxed_order"];
export const DEFAULT_STATEMENT_TIMEOUT_MS = 3000;
// query_canceled is shared by statement_timeout and by an operator cancelling the backend;
// only the former carries this message text.
const POSTGRES_QUERY_CANCELED_SQLSTATE = "57014";
const STATEMENT_TIMEOUT_MESSAGE = /statement timeout/i;
// Postgres rejects larger values for statement_timeout and hnsw.max_scan_tuples; a rejected
// set_config would fail the whole search, so an out-of-range value is treated as not set.
const POSTGRES_INTEGER_SETTING_MAX = 2_147_483_647;

function parsePositiveInteger(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > POSTGRES_INTEGER_SETTING_MAX) {
    console.warn(JSON.stringify({ event: "vector_scan_invalid_setting", name, value: raw }));
    return undefined;
  }
  return value;
}

export function resolveVectorScanConfig(env: VectorScanEnv): VectorScanConfig {
  const raw = env.VECTOR_ITERATIVE_SCAN?.trim();
  let mode: VectorScanMode = "off";
  if (raw) {
    if ((SCAN_MODES as readonly string[]).includes(raw)) {
      mode = raw as VectorScanMode;
    } else {
      // A typo must not silently look like "the flag does not work".
      console.warn(JSON.stringify({ event: "vector_scan_invalid_setting", name: "VECTOR_ITERATIVE_SCAN", value: raw }));
    }
  }
  // The numbers only matter while the scan is on; parsing them while it is off would log a
  // warning on every search for a setting that is not used.
  if (mode === "off") return { mode, statementTimeoutMs: DEFAULT_STATEMENT_TIMEOUT_MS };
  return {
    mode,
    maxScanTuples: parsePositiveInteger("VECTOR_MAX_SCAN_TUPLES", env.VECTOR_MAX_SCAN_TUPLES),
    statementTimeoutMs:
      parsePositiveInteger("VECTOR_STATEMENT_TIMEOUT_MS", env.VECTOR_STATEMENT_TIMEOUT_MS) ?? DEFAULT_STATEMENT_TIMEOUT_MS,
  };
}

/**
 * Sets the scan options for the current transaction only (set_config(..., true)); SET LOCAL cannot
 * take bound parameters. Must run inside the transaction opened by withUserContext, before the SELECT.
 */
export async function applyVectorScanSettings(sql: TaggedSql, config: VectorScanConfig): Promise<void> {
  if (config.mode === "off") return;
  await sql`SELECT set_config('hnsw.iterative_scan', ${config.mode}, true)`;
  if (config.maxScanTuples !== undefined) {
    await sql`SELECT set_config('hnsw.max_scan_tuples', ${String(config.maxScanTuples)}, true)`;
  }
  await sql`SELECT set_config('statement_timeout', ${String(config.statementTimeoutMs)}, true)`;
}

/** The iterative scan ran past its time budget; the caller degrades to keyword search. */
export class VectorScanTimeoutError extends Error {
  constructor(
    readonly mode: VectorScanMode,
    readonly timeoutMs: number,
    cause: unknown,
  ) {
    super(`Vector scan exceeded ${timeoutMs} ms (${mode})`, { cause });
    this.name = "VectorScanTimeoutError";
  }
}

export function isStatementTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === POSTGRES_QUERY_CANCELED_SQLSTATE && typeof message === "string" && STATEMENT_TIMEOUT_MESSAGE.test(message);
}
