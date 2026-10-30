// Tests for the iterative HNSW scan settings (WP-596 Ф10 п.12).

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveVectorScanConfig,
  applyVectorScanSettings,
  isStatementTimeout,
  VectorScanTimeoutError,
  DEFAULT_STATEMENT_TIMEOUT_MS,
} from "./vector-scan.js";

interface RecordedCall {
  text: string;
  values: unknown[];
}

function recordingSql() {
  const calls: RecordedCall[] = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve([]);
  };
  return { sql, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveVectorScanConfig", () => {
  it("is off with the default timeout and no scan cap when nothing is set", () => {
    expect(resolveVectorScanConfig({})).toEqual({
      mode: "off",
      maxScanTuples: undefined,
      statementTimeoutMs: DEFAULT_STATEMENT_TIMEOUT_MS,
    });
  });

  it.each(["off", "strict_order", "relaxed_order"] as const)("accepts mode %s", (mode) => {
    expect(resolveVectorScanConfig({ VECTOR_ITERATIVE_SCAN: mode }).mode).toBe(mode);
  });

  it("falls back to off and warns on an unknown mode, so a typo is visible", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveVectorScanConfig({ VECTOR_ITERATIVE_SCAN: "relaxed_orde" }).mode).toBe("off");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("vector_scan_invalid_setting");
    expect(warn.mock.calls[0][0]).toContain("relaxed_orde");
  });

  it("parses the numeric settings", () => {
    const config = resolveVectorScanConfig({
      VECTOR_ITERATIVE_SCAN: "relaxed_order",
      VECTOR_MAX_SCAN_TUPLES: "5000",
      VECTOR_STATEMENT_TIMEOUT_MS: "1500",
    });
    expect(config.maxScanTuples).toBe(5000);
    expect(config.statementTimeoutMs).toBe(1500);
  });

  // 2147483648 and 1e21 are integers but exceed what Postgres accepts for these settings; a
  // rejected set_config would fail every search while the flag is on.
  it.each(["0", "-5", "abc", "1.5", "2147483648", "3000000000", "1e21"])(
    "ignores the invalid or out-of-range number %s and warns",
    (raw) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const config = resolveVectorScanConfig({
        VECTOR_ITERATIVE_SCAN: "relaxed_order",
        VECTOR_MAX_SCAN_TUPLES: raw,
        VECTOR_STATEMENT_TIMEOUT_MS: raw,
      });
      expect(config.maxScanTuples).toBeUndefined();
      expect(config.statementTimeoutMs).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
      expect(warn).toHaveBeenCalledTimes(2);
    },
  );

  it("accepts the largest value Postgres allows", () => {
    const config = resolveVectorScanConfig({
      VECTOR_ITERATIVE_SCAN: "strict_order",
      VECTOR_MAX_SCAN_TUPLES: "2147483647",
      VECTOR_STATEMENT_TIMEOUT_MS: "2147483647",
    });
    expect(config.maxScanTuples).toBe(2_147_483_647);
    expect(config.statementTimeoutMs).toBe(2_147_483_647);
  });

  it("does not warn about numeric settings while the scan is off", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = resolveVectorScanConfig({ VECTOR_MAX_SCAN_TUPLES: "abc", VECTOR_STATEMENT_TIMEOUT_MS: "abc" });
    expect(config.mode).toBe("off");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("applyVectorScanSettings", () => {
  it("issues no statements at all when the scan is off", async () => {
    const { sql, calls } = recordingSql();
    await applyVectorScanSettings(sql, { mode: "off", maxScanTuples: 5000, statementTimeoutMs: 3000 });
    expect(calls).toHaveLength(0);
  });

  it("sets mode, scan cap and timeout, in that order, as transaction-local settings", async () => {
    const { sql, calls } = recordingSql();
    await applyVectorScanSettings(sql, { mode: "relaxed_order", maxScanTuples: 5000, statementTimeoutMs: 2500 });
    expect(calls.map((c) => c.values)).toEqual([["relaxed_order"], ["5000"], ["2500"]]);
    expect(calls[0].text).toContain("'hnsw.iterative_scan'");
    expect(calls[1].text).toContain("'hnsw.max_scan_tuples'");
    expect(calls[2].text).toContain("'statement_timeout'");
    for (const call of calls) expect(call.text).toContain(", true)");
  });

  it("leaves the pgvector scan cap alone when none is configured", async () => {
    const { sql, calls } = recordingSql();
    await applyVectorScanSettings(sql, { mode: "strict_order", statementTimeoutMs: 3000 });
    expect(calls.map((c) => c.values)).toEqual([["strict_order"], ["3000"]]);
    expect(calls.some((c) => c.text.includes("hnsw.max_scan_tuples"))).toBe(false);
  });
});

describe("statement timeout detection", () => {
  const timeoutError = () => Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });

  it("recognises a statement_timeout cancellation", () => {
    expect(isStatementTimeout(timeoutError())).toBe(true);
  });

  it("does not treat an operator cancellation (same SQLSTATE) as a timeout", () => {
    const operatorCancel = Object.assign(new Error("canceling statement due to user request"), { code: "57014" });
    expect(isStatementTimeout(operatorCancel)).toBe(false);
  });

  it("ignores other errors and non-errors", () => {
    expect(isStatementTimeout(Object.assign(new Error("statement timeout"), { code: "42P01" }))).toBe(false);
    expect(isStatementTimeout({ code: "57014" })).toBe(false);
    expect(isStatementTimeout(new Error("57014"))).toBe(false);
    expect(isStatementTimeout(null)).toBe(false);
  });

  it("keeps mode, budget and cause on the degradation error", () => {
    const cause = timeoutError();
    const error = new VectorScanTimeoutError("relaxed_order", 3000, cause);
    expect(error.mode).toBe("relaxed_order");
    expect(error.timeoutMs).toBe(3000);
    expect(error.cause).toBe(cause);
    expect(error.name).toBe("VectorScanTimeoutError");
  });
});
