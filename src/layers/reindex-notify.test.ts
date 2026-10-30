import { afterEach, describe, expect, it, vi } from "vitest";
import { firstErrorText, notifyJobFinished, renderNotice, shouldNotify } from "./reindex-notify.js";

const ENV = { REINDEX_NOTIFY_TELEGRAM_TOKEN: "tok", REINDEX_NOTIFY_CHAT_ID: "42" };

afterEach(() => vi.unstubAllGlobals());

describe("reindex notice criterion", () => {
  it("is silent for a successful incremental job, loud for every failure and full success", () => {
    expect(shouldNotify({ status: "succeeded", kind: "incremental" })).toBe(false);
    expect(shouldNotify({ status: "succeeded", kind: "full" })).toBe(true);
    expect(shouldNotify({ status: "failed", kind: "incremental" })).toBe(true);
    expect(shouldNotify({ status: "failed", kind: "full" })).toBe(true);
  });

  it("renders source and reason without any user identity, trimming long reasons", () => {
    const text = renderNotice({ status: "failed", kind: "full", source: "DS-x", reason: "e".repeat(500) });
    expect(text).toBe(`Полная переиндексация источника DS-x не удалась: ${"e".repeat(200)}`);
    expect(renderNotice({ status: "succeeded", kind: "full", source: "DS-x" })).toBe("Полная переиндексация источника DS-x завершена.");
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
    await notifyJobFinished(ENV, { status: "failed", kind: "incremental", source: "DS-x", reason: "boom" });
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
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows a network failure and never logs the token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("https://api.telegram.org/bottok/sendMessage down")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(notifyJobFinished(ENV, { status: "failed", kind: "full", source: "DS-x" })).resolves.toBeUndefined();
    expect(warn.mock.calls.flat().join(" ")).not.toContain("tok");
    warn.mockRestore();
  });
});
