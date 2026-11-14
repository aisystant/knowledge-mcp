import { afterEach, describe, expect, it, vi } from "vitest";
import { dependencyFailure, embeddingsOutage, firstErrorText, foreignSourceKey, notifyJobFinished, renderCenterEvent, renderNotice, shouldNotify, tagDependencyFailure, withoutDependencyTag } from "./reindex-notify.js";

const ENV = { REINDEX_NOTIFY_TELEGRAM_TOKEN: "tok", REINDEX_NOTIFY_CHAT_ID: "42" };
const CENTER = {
  REINDEX_CENTER_LOKI_URL: "https://logs.example/",
  REINDEX_CENTER_LOKI_USER: "77",
  REINDEX_CENTER_LOKI_TOKEN: "lokisecret",
  REINDEX_OPERATOR_USER_ID: "op-1",
};

afterEach(() => vi.unstubAllGlobals());

describe("reindex notice criterion", () => {
  it("is loud for every failure and silent for every success, full rebuild included", () => {
    expect(shouldNotify({ status: "succeeded" })).toBe(false);
    expect(shouldNotify({ status: "failed" })).toBe(true);
    expect(renderNotice({ status: "succeeded", kind: "incremental", source: "DS-x", userId: "op-1" }, "op-1")).toBeNull();
    expect(renderNotice({ status: "succeeded", kind: "full", source: "DS-x", userId: "op-1" }, "op-1")).toBeNull();
  });

  it("renders the operator's own source with its reason, trimming long reasons", () => {
    const own = { source: "DS-x", userId: "op-1" };
    expect(renderNotice({ ...own, status: "failed", kind: "full", reason: "e".repeat(500) }, "op-1"))
      .toBe(`Полная переиндексация источника DS-x не удалась: ${"e".repeat(200)}`);
    expect(renderNotice({ ...own, status: "failed", kind: "incremental", reason: "first", errorCount: 3 }, "op-1"))
      .toBe("Инкрементальная переиндексация источника DS-x не удалась: first (и ещё ошибок: 2)");
    expect(renderNotice({ ...own, status: "failed", kind: "incremental", reason: "only", errorCount: 1 }, "op-1"))
      .toBe("Инкрементальная переиндексация источника DS-x не удалась: only");
  });

  it("keeps another user's failure out of the chat once the operator is configured", () => {
    const foreign = { status: "failed", kind: "full", source: "SomeLogin/moi-rp", userId: "u-2", reason: "boom" } as const;
    expect(renderNotice(foreign, "op-1")).toBeNull();
    expect(renderNotice(foreign, " op-1\n")).toBeNull();
  });

  it("without a configured operator masks every source but still reaches the chat", () => {
    const text = renderNotice({
      status: "failed", kind: "full", source: "SomeLogin/moi-rp", userId: "u-2",
      reason: "Cannot read notes/a.md from GitHub (github_http_403)",
    }, undefined);
    expect(renderNotice({ status: "failed", kind: "full", source: "DS-mine", userId: "op-1", reason: "x" }, "  ")).not.toBeNull();
    expect(text).toBe("Полная переиндексация источника другого пользователя не удалась: не удалось прочитать файл из GitHub (github_http_403)");
    expect(text).not.toContain("SomeLogin");
    expect(text).not.toContain("notes/a.md");
  });

  it("reads the first error from strings and from objects", () => {
    expect(firstErrorText(["boom"])).toBe("boom");
    expect(firstErrorText([{ reason: "watchdog_stale_heartbeat" }])).toBe('{"reason":"watchdog_stale_heartbeat"}');
    expect(firstErrorText([])).toBeUndefined();
    expect(firstErrorText(null)).toBeUndefined();
  });
});

describe("notifyJobFinished", () => {
  it("sends exactly one request with a timeout signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await notifyJobFinished({ ...ENV, REINDEX_OPERATOR_USER_ID: "op-1" },
      { status: "failed", kind: "incremental", source: "DS-x", userId: "op-1", reason: "boom" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bottok/sendMessage");
    expect(JSON.parse(init.body)).toEqual({ chat_id: "42", text: "Инкрементальная переиндексация источника DS-x не удалась: boom" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends nothing when the channel is not configured or the outcome is routine", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await notifyJobFinished({}, { status: "failed", kind: "full", source: "DS-x" });
    await notifyJobFinished(ENV, { status: "succeeded", kind: "incremental", source: "DS-x" });
    await notifyJobFinished(ENV, { status: "succeeded", kind: "full", source: "DS-x" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs a failed delivery under the masked name of another user's source", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await notifyJobFinished(ENV, { status: "failed", kind: "full", source: "SomeLogin/x", userId: "u-2", reason: "boom" });
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("notify_failed");
    expect(logged).not.toContain("SomeLogin");
    warn.mockRestore();
  });

  it("swallows a network failure and never logs the token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("https://api.telegram.org/bottok/sendMessage down")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(notifyJobFinished(ENV, { status: "failed", kind: "full", source: "DS-x" })).resolves.toBeUndefined();
    expect(warn.mock.calls.flat().join(" ")).not.toContain("tok");
    warn.mockRestore();
  });
});

describe("Notification Center event", () => {
  it("keeps the name of the operator's own source", () => {
    const ev = renderCenterEvent(
      { status: "failed", kind: "incremental", source: "DS-mine", userId: "op-1", reason: "Cannot read DS-mine/a.md" },
      "op-1",
    );
    expect(ev).toEqual({
      title: "Инкрементальная переиндексация не удалась: DS-mine",
      detail: "Cannot read DS-mine/a.md",
      correlationId: "knowledge-reindex:incremental:DS-mine",
    });
  });

  it("hides another user's source name in title, reason and correlation id", () => {
    const ev = renderCenterEvent(
      { status: "failed", kind: "full", source: "DS-health", userId: "u-2", reason: "Cannot read DS-health/x.md from GitHub", errorCount: 3 },
      "op-1",
    );
    expect(ev?.title).toBe("Полная переиндексация не удалась: источник другого пользователя");
    expect(ev?.detail).toBe("внутренняя ошибка, подробности в журнале сервера (и ещё ошибок: 2)");
    expect(JSON.stringify(ev)).not.toContain("DS-health");
  });

  it("passes only a fixed cause category for another user's job, never the free text", () => {
    const leaky = [
      ["Cannot read diagnoses/2026.md from GitHub (github_http_404)", "не удалось прочитать файл из GitHub (github_http_404)"],
      ["Unknown source: DS-x. User sources: DS-health, DS-finance", "источник не найден у пользователя"],
      ["Invalid user context for user_id=0b1c2d3e-aaaa-bbbb-cccc-111122223333", "неверный контекст пользователя"],
      ['duplicate key value violates unique constraint, Key (user_id, source)=(0b1c2d3e, DS-x)', "внутренняя ошибка, подробности в журнале сервера"],
      ['{"reason":"watchdog_stale_heartbeat"}', "задача зависла, пакеты перестали обрабатываться"],
      ["задача так и не стартовала", "задача так и не стартовала"],
      [
        "DS-health/diagnoses/2026.md: Сервис не завершил чтение вовремя. Повтори запрос позже; файл не объявлен отсутствующим.",
        "чтение файлов из GitHub не уложилось во время",
      ],
    ] as const;
    for (const [reason, expected] of leaky) {
      const ev = renderCenterEvent({ status: "failed", kind: "incremental", source: "DS-x", userId: "u-2", reason }, "op-1");
      expect(ev?.detail).toBe(expected);
      for (const secret of ["DS-health", "DS-finance", "0b1c2d3e", "diagnoses", "DS-x"]) {
        expect(JSON.stringify(ev)).not.toContain(secret);
      }
    }
  });

  it("does not break on an empty source name", () => {
    const ev = renderCenterEvent({ status: "failed", kind: "full", source: "", userId: "u-2", reason: "Unknown source: " }, "op-1");
    expect(ev?.detail).toBe("источник не найден у пользователя");
  });

  it("matches the operator id even with stray whitespace in the stored value", () => {
    const ev = renderCenterEvent({ status: "failed", kind: "full", source: "DS-mine", userId: "op-1", reason: "boom" }, " op-1\n");
    expect(ev?.title).toBe("Полная переиндексация не удалась: DS-mine");
    expect(ev?.detail).toBe("boom");
  });

  it("treats every source as foreign while the operator id is not configured", () => {
    const ev = renderCenterEvent({ status: "failed", kind: "full", source: "DS-mine", userId: "op-1" }, undefined);
    expect(ev?.title).toBe("Полная переиндексация не удалась: источник другого пользователя");
  });

  it("does not count successes", () => {
    expect(renderCenterEvent({ status: "succeeded", kind: "full", source: "DS-x" }, "op-1")).toBeNull();
  });

  it("tells foreign sources apart by a pseudonymous key, never by name", async () => {
    const a = { status: "failed", kind: "incremental", source: "Login/DS-a", userId: "u-2" } as const;
    const b = { ...a, source: "Login/DS-b" };
    const keyA = await foreignSourceKey(a);
    expect(keyA).toMatch(/^[0-9a-f]{8}$/);
    expect(await foreignSourceKey(a)).toBe(keyA);
    expect(await foreignSourceKey(b)).not.toBe(keyA);
    expect(await foreignSourceKey({ ...a, userId: "u-3" })).not.toBe(keyA);
    const ev = renderCenterEvent(a, "op-1", keyA);
    expect(ev?.correlationId).toBe(`knowledge-reindex:incremental:источник другого пользователя:${keyA}`);
    expect(JSON.stringify(ev)).not.toContain("Login");
  });

  it("keeps the operator's own source keyed by its name only", async () => {
    const own = { status: "failed", kind: "incremental", source: "DS-mine", userId: "op-1" } as const;
    expect(renderCenterEvent(own, "op-1", await foreignSourceKey(own))?.correlationId).toBe("knowledge-reindex:incremental:DS-mine");
  });
});

describe("dual write to Telegram and the Center", () => {
  it("writes another user's failure to the Center only, one Loki stream line", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await notifyJobFinished({ ...ENV, ...CENTER }, { status: "failed", kind: "incremental", source: "DS-x", userId: "u-2", reason: "boom" });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["https://logs.example/loki/api/v1/push"]);
    const center = fetchMock.mock.calls.find((c) => c[0] === "https://logs.example/loki/api/v1/push");
    expect(center).toBeDefined();
    const init = center![1];
    expect(init.headers.authorization).toBe(`Basic ${btoa("77:lokisecret")}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    expect(body.streams).toHaveLength(1);
    expect(body.streams[0].stream).toEqual({ job: "notification-center", source: "knowledge-reindex", severity: "warning", needs_decision: "false" });
    const [ts, line] = body.streams[0].values[0];
    expect(ts).toMatch(/^\d{19}$/);
    expect(JSON.parse(line)).toEqual({
      schema_version: 1,
      event: "notification",
      title: "Инкрементальная переиндексация не удалась: источник другого пользователя",
      detail: "внутренняя ошибка, подробности в журнале сервера",
      correlation_id: `knowledge-reindex:incremental:источник другого пользователя:${await foreignSourceKey({ userId: "u-2", source: "DS-x" })}`,
    });
  });

  it("without a configured operator sends the same masked failure text to Telegram and the Center", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await notifyJobFinished({ ...ENV, ...CENTER, REINDEX_OPERATOR_USER_ID: undefined },
      { status: "failed", kind: "incremental", source: "SomeLogin/x", userId: "u-2", reason: "boom" });
    const tg = fetchMock.mock.calls.find((c) => c[0] === "https://api.telegram.org/bottok/sendMessage");
    const center = fetchMock.mock.calls.find((c) => c[0] === "https://logs.example/loki/api/v1/push");
    const cause = "внутренняя ошибка, подробности в журнале сервера";
    expect(JSON.parse(tg![1].body).text)
      .toBe(`Инкрементальная переиндексация источника другого пользователя не удалась: ${cause}`);
    const line = JSON.parse(JSON.parse(center![1].body).streams[0].values[0][1]);
    expect(line.title).toBe("Инкрементальная переиндексация не удалась: источник другого пользователя");
    expect(line.detail).toBe(cause);
    expect(`${tg![1].body}${center![1].body}`).not.toContain("SomeLogin");
  });

  it("writes nothing anywhere for a full success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await notifyJobFinished({ ...ENV, ...CENTER }, { status: "succeeded", kind: "full", source: "DS-x" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes to the Center alone once Telegram is switched off", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await notifyJobFinished(CENTER, { status: "failed", kind: "full", source: "DS-x" });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["https://logs.example/loki/api/v1/push"]);
  });

  it("keeps Telegram delivery when the Center rejects, and never logs the Loki token", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      url.includes("/loki/") ? Promise.reject(new Error("lokisecret leaked?")) : Promise.resolve({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(notifyJobFinished({ ...ENV, ...CENTER }, { status: "failed", kind: "full", source: "DS-x", userId: "op-1" })).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map((c) => c[0])).toContain("https://api.telegram.org/bottok/sendMessage");
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("center_write_failed");
    expect(logged).not.toContain("lokisecret");
    warn.mockRestore();
  });

  it("retries a failed Center write once with the identical body, and not a rejected one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const job = { status: "failed", kind: "full", source: "DS-x", userId: "u-2" } as const;
    const flaky = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", flaky);
    await notifyJobFinished(CENTER, job);
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(flaky.mock.calls[1][1].body).toBe(flaky.mock.calls[0][1].body);
    const rejected = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal("fetch", rejected);
    await notifyJobFinished(CENTER, job);
    expect(rejected).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("embeddings outage (WP-568 Ф10, 14.11)", () => {
  const DENIED = tagDependencyFailure("guide/2026-11-14.md: Сервис отклонил доступ. Проверь подключение; повтор того же запроса не восстановит права.",
    { stage: "embeddings", code: "dependency_access_denied" });
  const TELEGRAM = "https://api.telegram.org/bottok/sendMessage";
  const LOKI = "https://logs.example/loki/api/v1/push";

  it("reads the stage and code back from the tag, and nothing from an untagged reason", () => {
    expect(dependencyFailure(DENIED)).toEqual({ stage: "embeddings", code: "dependency_access_denied" });
    expect(dependencyFailure("guide/x.md: Сервис отклонил доступ.")).toBeUndefined();
    expect(embeddingsOutage(DENIED)).toBe("dependency_access_denied");
    expect(embeddingsOutage(tagDependencyFailure("x", { stage: "embeddings", code: "dependency_timeout" }))).toBeUndefined();
    expect(embeddingsOutage(tagDependencyFailure("x", { stage: "github_token", code: "dependency_access_denied" }))).toBeUndefined();
  });

  it("names a dependency failure of another user's job instead of an internal error", () => {
    const foreign = { status: "failed", kind: "incremental", source: "DS-x", userId: "u-2" } as const;
    expect(renderCenterEvent({ ...foreign, reason: DENIED }, "op-1")?.detail).toBe("сервис векторов отклонил доступ");
    expect(renderCenterEvent({ ...foreign, reason: tagDependencyFailure("x", { stage: "nowhere", code: "made_up" }) }, "op-1")?.detail)
      .toBe("внешний сервис отказал");
  });

  it("shows the operator's own reason without the machine tag", () => {
    expect(renderNotice({ status: "failed", kind: "incremental", source: "DS-x", userId: "op-1", reason: DENIED }, "op-1"))
      .toBe("Инкрементальная переиндексация источника DS-x не удалась: guide/2026-11-14.md: Сервис отклонил доступ. Проверь подключение; повтор того же запроса не восстановит права.");
  });

  it("sends no per-job chat message and writes one decision item next to the job line", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await notifyJobFinished({ ...ENV, ...CENTER }, { status: "failed", kind: "incremental", source: "DS-x", userId: "op-1", reason: DENIED });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([LOKI]);
    const streams = JSON.parse(fetchMock.mock.calls[0][1].body).streams;
    expect(streams.map((s: { stream: Record<string, string> }) => [s.stream.severity, s.stream.needs_decision]))
      .toEqual([["warning", "false"], ["critical", "true"]]);
    const decision = JSON.parse(streams[1].values[0][1]);
    expect(decision.correlation_id).toBe("knowledge-reindex:embeddings:dependency_access_denied");
    expect(decision.detail).toContain("Что делать:");
    expect(decision.title).not.toContain("DS-x");
    log.mockRestore();
  });

  it("labels an embeddings timeout by its tag, not as a GitHub read timeout", () => {
    const reason = tagDependencyFailure("a.md: Сервис не завершил чтение вовремя.", { stage: "embeddings", code: "dependency_timeout" });
    expect(renderCenterEvent({ status: "failed", kind: "incremental", source: "DS-x", userId: "u-2", reason }, "op-1")?.detail)
      .toBe("сервис векторов не ответил вовремя");
  });

  it("falls back to the per-job chat message when the Center rejects the decision item", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockImplementation(async (url: string) => (url === LOKI ? { ok: false, status: 401 } : { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await notifyJobFinished({ ...ENV, ...CENTER }, { status: "failed", kind: "incremental", source: "DS-x", userId: "op-1", reason: DENIED });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([LOKI, TELEGRAM]);
    warn.mockRestore();
  });

  it("strips the tag for any reader of the job errors", () => {
    expect(withoutDependencyTag(DENIED)).toBe("guide/2026-11-14.md: Сервис отклонил доступ. Проверь подключение; повтор того же запроса не восстановит права.");
    expect(withoutDependencyTag("plain reason")).toBe("plain reason");
  });

  it("keeps the per-job chat message while the Center is not configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await notifyJobFinished({ ...ENV, REINDEX_OPERATOR_USER_ID: "op-1" },
      { status: "failed", kind: "incremental", source: "DS-x", userId: "op-1", reason: DENIED });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([TELEGRAM]);
  });
});
