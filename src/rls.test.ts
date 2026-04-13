/**
 * Smoke-тесты для withUserContext (WP-212 B4.22-3)
 *
 * Проверяют:
 * 1. SET LOCAL app.user_id устанавливается при наличии userId
 * 2. SET LOCAL не вызывается для null userId (платформенные запросы)
 * 3. ROLLBACK вызывается при ошибке в fn
 * 4. Соединение освобождается в любом случае (release)
 * 5. Разные userId не смешиваются
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---

const mockQuery = vi.fn();
const mockRelease = vi.fn();
const mockConnect = vi.fn();

vi.mock("@neondatabase/serverless", () => ({
  neonConfig: {},
  Pool: vi.fn(function (this: unknown) {
    // Нужен function (не стрелка) чтобы работать как конструктор
    (this as { connect: typeof mockConnect }).connect = mockConnect;
  }),
}));

// Импортируем ПОСЛЕ настройки мока (top-level await)
const { withUserContext, _resetPool } = await import("./rls.js");

const DB_URL = "postgresql://test:test@localhost/test";
const USER_A = "user-ory-uuid-a";
const USER_B = "user-ory-uuid-b";

beforeEach(() => {
  vi.clearAllMocks();
  _resetPool();
  mockConnect.mockResolvedValue({
    query: mockQuery,
    release: mockRelease,
  });
  mockQuery.mockResolvedValue({ rows: [] });
});

// --- Тест 1: SET LOCAL устанавливается для userId ---

describe("withUserContext — SET LOCAL", () => {
  it("вызывает BEGIN / SET LOCAL / COMMIT при наличии userId", async () => {
    await withUserContext(DB_URL, USER_A, async () => []);

    const calls = mockQuery.mock.calls.map((c) => c[0] as string);
    expect(calls[0]).toBe("BEGIN");
    expect(calls.some((q) => q.includes("SET LOCAL app.user_id"))).toBe(true);
    expect(calls[calls.length - 1]).toBe("COMMIT");
  });

  it("передаёт правильный userId в SET LOCAL", async () => {
    await withUserContext(DB_URL, USER_A, async () => []);

    const setLocalCall = mockQuery.mock.calls.find(
      ([q]) => typeof q === "string" && q.includes("SET LOCAL app.user_id")
    );
    expect(setLocalCall).toBeDefined();
    expect(setLocalCall![1]).toEqual([USER_A]);
  });

  it("НЕ вызывает SET LOCAL для null userId", async () => {
    await withUserContext(DB_URL, null, async () => []);

    const calls = mockQuery.mock.calls.map(([q]) => q as string);
    expect(calls.some((q) => q.includes("SET LOCAL app.user_id"))).toBe(false);
    expect(calls[0]).toBe("BEGIN");
    expect(calls[calls.length - 1]).toBe("COMMIT");
  });

  it("НЕ вызывает SET LOCAL для undefined userId", async () => {
    await withUserContext(DB_URL, undefined, async () => []);

    const calls = mockQuery.mock.calls.map(([q]) => q as string);
    expect(calls.some((q) => q.includes("SET LOCAL app.user_id"))).toBe(false);
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
      .filter(([q]) => typeof q === "string" && q.includes("SET LOCAL app.user_id"))
      .map(([, args]) => args as string[]);

    for (const args of setLocalArgs) {
      expect(args).not.toContain(USER_B);
    }
  });
});
