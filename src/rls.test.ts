/**
 * Smoke-тесты для withUserContext (WP-212 B4.22-3)
 *
 * Проверяют:
 * 1. set_config устанавливается при наличии userId
 * 2. SET LOCAL не вызывается для null userId (платформенные запросы)
 * 3. ROLLBACK вызывается при ошибке в fn
 * 4. Соединение освобождается в любом случае (release)
 * 5. Разные userId не смешиваются
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createReadTrace } from "./read-failure.js";

// --- Mocks ---

const mockQuery = vi.fn();
const mockRelease = vi.fn();
const mockConnect = vi.fn();
const mockOn = vi.fn();
const mockEnd = vi.fn();

vi.mock("@neondatabase/serverless", () => ({
  neonConfig: {},
  Pool: vi.fn(function (this: unknown) {
    // Нужен function (не стрелка) чтобы работать как конструктор
    (this as { connect: typeof mockConnect }).connect = mockConnect;
    (this as { on: typeof mockOn }).on = mockOn;
    (this as { end: typeof mockEnd }).end = mockEnd;
  }),
}));

// Импортируем ПОСЛЕ настройки мока (top-level await)
const { withUserContext, createRequestPool } = await import("./rls.js");

const DB_URL = "postgresql://test:test@localhost/test";
const USER_A = "user-ory-uuid-a";
const USER_B = "user-ory-uuid-b";

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue({
    query: mockQuery,
    release: mockRelease,
  });
  mockQuery.mockResolvedValue({ rows: [] });
  mockEnd.mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

// --- Тест 1: SET LOCAL устанавливается для userId ---

describe("withUserContext — SET LOCAL", () => {
  it("вызывает BEGIN / SET LOCAL / COMMIT при наличии userId", async () => {
    await withUserContext(DB_URL, USER_A, async () => []);

    const calls = mockQuery.mock.calls.map((c) => c[0] as string);
    expect(calls[0]).toBe("BEGIN");
    expect(calls.some((q) => q.includes("set_config"))).toBe(true);
    expect(calls[calls.length - 1]).toBe("COMMIT");
  });

  it("передаёт правильный userId в SET LOCAL", async () => {
    await withUserContext(DB_URL, USER_A, async () => []);

    const setLocalCall = mockQuery.mock.calls.find(
      ([q]) => typeof q === "string" && q.includes("set_config")
    );
    expect(setLocalCall).toBeDefined();
    expect(setLocalCall![1]).toEqual([USER_A]);
  });

  it("НЕ вызывает SET LOCAL для null userId", async () => {
    await withUserContext(DB_URL, null, async () => []);

    const calls = mockQuery.mock.calls.map(([q]) => q as string);
    expect(calls.some((q) => q.includes("set_config"))).toBe(false);
    expect(calls[0]).toBe("BEGIN");
    expect(calls[calls.length - 1]).toBe("COMMIT");
  });

  it("НЕ вызывает SET LOCAL для undefined userId", async () => {
    await withUserContext(DB_URL, undefined, async () => []);

    const calls = mockQuery.mock.calls.map(([q]) => q as string);
    expect(calls.some((q) => q.includes("set_config"))).toBe(false);
  });
});

// --- Тест 2: ROLLBACK при ошибке ---

describe("withUserContext — ROLLBACK", () => {
  it("вызывает ROLLBACK если fn бросает ошибку", async () => {
    await expect(
      withUserContext(DB_URL, USER_A, async () => {
        throw new Error("тестовая ошибка");
      })
    ).rejects.toThrow("тестовая ошибка");

    const calls = mockQuery.mock.calls.map(([q]) => q as string);
    expect(calls).toContain("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
  });

  it("освобождает соединение даже при ошибке", async () => {
    await expect(
      withUserContext(DB_URL, USER_A, async () => {
        throw new Error("ошибка");
      })
    ).rejects.toThrow();

    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it("освобождает соединение при успехе", async () => {
    await withUserContext(DB_URL, USER_A, async () => []);
    expect(mockRelease).toHaveBeenCalledOnce();
  });
});

// --- Тест 3: изоляция пользователей ---

describe("withUserContext — изоляция userId", () => {
  it("USER_A не получает USER_B в SET LOCAL", async () => {
    await withUserContext(DB_URL, USER_A, async () => []);

    const setLocalArgs = mockQuery.mock.calls
      .filter(([q]) => typeof q === "string" && q.includes("set_config"))
      .map(([, args]) => args as string[]);

    for (const args of setLocalArgs) {
      expect(args).not.toContain(USER_B);
    }
  });
});

// --- Test 4: pool lifecycle doesn't crash the worker or leak across requests (issue #231) ---

describe("withUserContext — pool lifecycle", () => {
  it("регистрирует обработчик ошибки простаивающего клиента, чтобы emit('error') не бросал необработанное исключение", async () => {
    await withUserContext(DB_URL, USER_A, async () => []);

    const errorCall = mockOn.mock.calls.find(([event]) => event === "error");
    expect(errorCall).toBeDefined();

    const errorHandler = errorCall![1] as (err: Error) => void;
    // Before this handler existed, emitting "error" on the Pool (an EventEmitter) with no
    // listener threw — that's how an idle dropped connection crashed the worker (an
    // unrelated in-flight request saw HTTP 500).
    expect(() => errorHandler(new Error("connection terminated unexpectedly"))).not.toThrow();
  });

  it("без общего пула создаёт и закрывает свой собственный пул на каждый вызов (не переживает запрос)", async () => {
    await withUserContext(DB_URL, USER_A, async () => []);
    await withUserContext(DB_URL, USER_A, async () => []);

    const { Pool } = await import("@neondatabase/serverless");
    expect(vi.mocked(Pool)).toHaveBeenCalledTimes(2);
    expect(mockEnd).toHaveBeenCalledTimes(2);
  });

  it("с общим пулом (createRequestPool) переиспользует его между вызовами и не закрывает сам", async () => {
    const { Pool } = await import("@neondatabase/serverless");
    const sharedPool = createRequestPool(DB_URL);
    vi.mocked(Pool).mockClear();

    await withUserContext(DB_URL, USER_A, async () => [], sharedPool);
    await withUserContext(DB_URL, USER_A, async () => [], sharedPool);

    expect(vi.mocked(Pool)).not.toHaveBeenCalled(); // no new Pool created inside withUserContext
    expect(mockEnd).not.toHaveBeenCalled(); // caller owns pool.end(), not withUserContext
  });
});

describe("withUserContext — safe phase diagnostics", () => {
  it("reports a stalled SQL start before completion, then returns unchanged rows", async () => {
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    let finishQuery!: (value: { rows: { value: string }[] }) => void;
    let queryStarted!: () => void;
    const started = new Promise<void>((resolve) => { queryStarted = resolve; });
    mockQuery.mockImplementation((query: string) => {
      if (query === "SELECT $1") {
        queryStarted();
        return new Promise((resolve) => { finishQuery = resolve; });
      }
      return Promise.resolve({ rows: [] });
    });

    const pending = withUserContext(DB_URL, USER_A, (sql) => sql`SELECT ${42}`, undefined, createReadTrace("platform_search"));
    await started;
    const events = () => logs.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(events().filter((event) => event.stage === "db_query").map((event) => event.phase)).toEqual(["start"]);
    expect(mockQuery.mock.calls.some(([query]) => query === "COMMIT")).toBe(false);

    finishQuery({ rows: [{ value: "private-result-sentinel" }] });
    await expect(pending).resolves.toEqual([{ value: "private-result-sentinel" }]);
    expect(JSON.stringify(events())).not.toContain("private-result-sentinel");
    expect(mockQuery.mock.calls.filter(([query]) => String(query).includes("set_config")).map(([, args]) => args)).toEqual([
      [USER_A], [USER_A], [USER_A], [USER_A], [USER_A],
    ]);
    expect(events().filter((event) => event.phase === "start").map((event) => event.stage)).toEqual([
      "db_connect", "db_begin", "db_context", "db_query", "db_commit",
    ]);
    expect(events().filter((event) => event.stage === "db_query").map((event) => event.phase)).toEqual(["start", "end"]);
    expect(mockRelease).toHaveBeenCalledOnce();
    expect(mockEnd).toHaveBeenCalledOnce();
  });

  it("keeps the original query error, rolls back and never logs SQL, identity or result data", async () => {
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    const privateSql = "SELECT private_document FROM private_table WHERE token = $1";
    const privateToken = "private-token-sentinel";
    const original = new Error("private-exception-sentinel");
    mockQuery.mockImplementation((query: string) => query === privateSql
      ? Promise.reject(original)
      : Promise.resolve({ rows: [] }));

    await expect(withUserContext(DB_URL, USER_A, (sql) =>
      sql`SELECT private_document FROM private_table WHERE token = ${privateToken}`,
    undefined, createReadTrace("platform_search"))).rejects.toBe(original);

    const events = logs.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(events.find((event) => event.stage === "db_query" && event.phase === "end")).toMatchObject({ outcome: "error", error_kind: "unclassified" });
    expect(events.filter((event) => event.stage === "db_rollback").map((event) => event.phase)).toEqual(["start", "end"]);
    expect(mockQuery.mock.calls.map(([query]) => query)).not.toContain("COMMIT");
    expect(mockRelease).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(events);
    for (const value of [DB_URL, USER_A, USER_B, privateSql, privateToken, original.message]) {
      expect(serialized).not.toContain(value);
    }
    for (const event of events) {
      expect(Object.keys(event).every((key) => ["event", "trace_id", "operation", "stage", "phase", "elapsed_ms", "outcome", "error_kind"].includes(key))).toBe(true);
    }
  });

  it("traces a context failure without running user SQL and preserves rollback", async () => {
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    const original = new Error("context failure");
    mockQuery.mockImplementation((query: string) => query.includes("set_config")
      ? Promise.reject(original)
      : Promise.resolve({ rows: [] }));
    const callback = vi.fn(async () => []);

    await expect(withUserContext(DB_URL, USER_A, callback, undefined, createReadTrace("platform_search"))).rejects.toBe(original);

    expect(callback).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls.map(([query]) => query)).toContain("ROLLBACK");
    expect(logs.mock.calls.map(([line]) => JSON.parse(String(line))).find((event) => event.stage === "db_context" && event.phase === "end")).toMatchObject({ outcome: "error" });
  });

  it("skips context diagnostics for anonymous calls and emits nothing without a trace", async () => {
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    await withUserContext(DB_URL, null, async () => [], undefined, createReadTrace("platform_search"));
    expect(logs.mock.calls.map(([line]) => JSON.parse(String(line))).some((event) => event.stage === "db_context")).toBe(false);

    logs.mockClear();
    await withUserContext(DB_URL, USER_A, async () => []);
    expect(logs).not.toHaveBeenCalled();
  });
});
