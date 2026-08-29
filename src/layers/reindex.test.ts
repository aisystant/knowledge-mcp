// Tests for the private-mode reindex pipeline (WP-410 срез-2b Деплой-2 группа Б).
// Ported logic (personalReindexFiles/handleQueue/handleWatchdog/getReindexJobStatus/
// startReindexJob) is exercised against a mocked neon() tag function and mocked global fetch —
// no live Neon connection, no live GitHub API call, no live Cloudflare Queue.
//
// getInstallationToken is mocked at the module level (not exercised through real crypto): it
// signs a GitHub App JWT with an RSA private key, which a fake PEM string cannot satisfy.
// personal.test.ts takes the same shortcut for writeToGitHub/deleteFromGitHub (only the
// unknown-source early-return path is covered there) — this is an accepted gap, closed by the
// live Ory-JWT smoke required after every WP-410 cut-over group, not by unit tests.

import { describe, it, expect, vi, beforeEach } from "vitest";

let queryQueue: (unknown[] | Error)[] = [];
let sqlCalls: unknown[][] = [];

function nextSqlResult(): unknown[] {
  const next = queryQueue.shift();
  if (next instanceof Error) throw next;
  return next ?? [];
}

function makeMockSql() {
  const sql = ((..._args: unknown[]) => {
    sqlCalls.push(_args);
    try {
      return Promise.resolve(nextSqlResult());
    } catch (err) {
      return Promise.reject(err);
    }
  }) as unknown as {
    (..._args: unknown[]): Promise<unknown[]>;
    unsafe: (v: string) => string;
    transaction: (queries: Promise<unknown>[]) => Promise<unknown[]>;
  };
  sql.unsafe = (v: string) => v;
  // Each query in the array already fired (and consumed its queryQueue entry)
  // when the array literal was built — this just awaits them together, close
  // enough to real transaction semantics for a unit test (WP-7 Ф94).
  sql.transaction = (queries: Promise<unknown>[]) => Promise.all(queries);
  return sql;
}

vi.mock("@neondatabase/serverless", () => ({
  neon: vi.fn(() => makeMockSql()),
}));

vi.mock("./personal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./personal.js")>();
  return { ...actual, getInstallationToken: vi.fn().mockResolvedValue("ghs_fake_installation_token") };
});

import {
  personalReindexFiles,
  handleQueue,
  handleWatchdog,
  getReindexJobStatus,
  startReindexJob,
  chunkContent,
  contentHash,
  mapWithConcurrency,
  type ReindexEnv,
  type ReindexBatchMessage,
} from "./reindex.js";
import { assertIndexablePath } from "./personal.js";

beforeEach(() => {
  queryQueue = [];
  sqlCalls = [];
});

const ENV: ReindexEnv = {
  DATABASE_URL: "postgres://fake",
  OPENROUTER_API_KEY: "fake-key",
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "fake",
};

const USER_ID = "11111111-1111-1111-1111-111111111111";

function sourceRow() {
  return { source: "DS-my-strategy", github_owner: "TserenTserenov", github_repo: "DS-my-strategy", path_prefix: "", source_type: "ds" };
}

describe("chunkContent", () => {
  it("returns a single chunk for short content, regardless of headers", () => {
    const content = "intro\n## Раздел А\nбыло";
    expect(chunkContent(content)).toEqual([content]);
  });

  it("splits by ## headers once content exceeds the chunk-size threshold, reconstructing exactly", () => {
    const filler = "x".repeat(5_000);
    const content = `intro text ${filler}\n## Раздел А\n${filler} было\n## Раздел Б\nстало`;
    const chunks = chunkContent(content);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(content);
  });

  it("hard-splits a single paragraph longer than CHUNK_SIZE and still reconstructs exactly", () => {
    const content = "y".repeat(20_000);
    const chunks = chunkContent(content);
    expect(chunks.join("")).toBe(content);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(8_000);
  });

  it("does not lose a section on a duplicate heading — ordinal is positional, not key-based", () => {
    const content = "## Same\nfirst " + "a".repeat(8_100) + "\n## Same\nsecond " + "b".repeat(8_100);
    const chunks = chunkContent(content);
    expect(chunks.join("")).toBe(content);
    expect(chunks.some(c => c.includes("first"))).toBe(true);
    expect(chunks.some(c => c.includes("second"))).toBe(true);
  });
});

describe("assertIndexablePath", () => {
  it("rejects a literal chunk separator, accepts an ordinary path", () => {
    expect(() => assertIndexablePath("docs/a::b.md")).toThrow(/reserved chunk separator/);
    expect(() => assertIndexablePath("docs/a.md")).not.toThrow();
  });
});

describe("mapWithConcurrency", () => {
  it("respects the concurrency bound and returns results in input order", async () => {
    let active = 0;
    let maxActive = 0;
    const items = [50, 10, 30, 5, 20, 15, 40, 25];
    const results = await mapWithConcurrency(items, 3, async (ms, i) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, ms));
      active--;
      return i;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(results).toEqual(items.map((_, i) => i));
  });
});

describe("contentHash", () => {
  it("is deterministic and 16 chars long", async () => {
    const a = await contentHash("same text");
    const b = await contentHash("same text");
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it("differs for different content", async () => {
    const a = await contentHash("text one");
    const b = await contentHash("text two");
    expect(a).not.toBe(b);
  });
});

describe("personalReindexFiles", () => {
  it("errors without user_id, without touching the DB", async () => {
    const result = await personalReindexFiles(ENV, { source: "DS-my-strategy", files: [] });
    expect(result.errors).toEqual(["Missing user_id: personal reindex requires authenticated user context"]);
    expect(queryQueue).toHaveLength(0); // nothing consumed — proves no DB call happened
  });

  it("errors on a source the user hasn't connected", async () => {
    queryQueue.push([sourceRow()]); // resolveUserContext
    const result = await personalReindexFiles(ENV, {
      source: "not-connected", files: [{ path: "a.md", action: "modified" }], user_id: USER_ID,
    });
    expect(result.errors[0]).toContain("Unknown source: not-connected");
  });

  it("skips non-markdown files without reading GitHub", async () => {
    queryQueue.push([sourceRow()]); // resolveUserContext
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();
    const result = await personalReindexFiles(ENV, {
      source: "DS-my-strategy", files: [{ path: "image.png", action: "modified" }], user_id: USER_ID,
    });
    expect(result.skipped).toBe(1);
    expect(result.processed).toBe(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    globalThis.fetch = originalFetch;
  });

  it("deletes on action=removed without reading GitHub", async () => {
    queryQueue.push([sourceRow()]); // resolveUserContext
    queryQueue.push([]); // DELETE result (ignored)
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();
    const result = await personalReindexFiles(ENV, {
      source: "DS-my-strategy", files: [{ path: "gone.md", action: "removed" }], user_id: USER_ID,
    });
    expect(result.deleted).toBe(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    globalThis.fetch = originalFetch;
  });

  it("skips a file whose content hash is unchanged and already on v2", async () => {
    const hash = await contentHash("unchanged content");
    queryQueue.push([sourceRow()]); // resolveUserContext
    queryQueue.push([{ hash, protocol_version: 2 }]); // hash check — matches, already backfilled

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: true, text: async () => "unchanged content" }); // file content

    const result = await personalReindexFiles(ENV, {
      source: "DS-my-strategy", files: [{ path: "note.md", action: "modified" }], user_id: USER_ID,
    });
    expect(result.skipped).toBe(1);
    expect(result.processed).toBe(0);
    globalThis.fetch = originalFetch;
  });

  it("does NOT skip an unchanged file still on legacy protocol_version — backfills it (WP-7 Ф94 regression)", async () => {
    const hash = await contentHash("unchanged legacy content");
    queryQueue.push([sourceRow()]); // resolveUserContext
    queryQueue.push([{ hash, protocol_version: 1 }]); // hash matches, but still legacy

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => "unchanged legacy content" })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) }); // embedding

    const result = await personalReindexFiles(ENV, {
      source: "DS-my-strategy", files: [{ path: "note.md", action: "modified" }], user_id: USER_ID,
    });
    expect(result.skipped).toBe(0);
    expect(result.processed).toBe(1);
    globalThis.fetch = originalFetch;
  });

  it("processes a changed file: reads GitHub, embeds, and inserts", async () => {
    queryQueue.push([sourceRow()]); // resolveUserContext
    queryQueue.push([{ hash: "0000000000000000" }]); // hash check — different, proceed
    queryQueue.push([]); // DELETE old chunks
    queryQueue.push([]); // INSERT result (ignored)

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => "new content" })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) }); // embedding

    const result = await personalReindexFiles(ENV, {
      source: "DS-my-strategy", files: [{ path: "note.md", action: "modified" }], user_id: USER_ID,
    });
    expect(result.processed).toBe(1);
    expect(result.errors).toEqual([]);
    globalThis.fetch = originalFetch;
  });
});

describe("getReindexJobStatus", () => {
  it("returns null for an unknown job", async () => {
    queryQueue.push([]);
    const status = await getReindexJobStatus(ENV, USER_ID, "22222222-2222-2222-2222-222222222222");
    expect(status).toBeNull();
  });

  it("maps a found job row", async () => {
    queryQueue.push([{
      id: "job-1", source: "DS-my-strategy", status: "running",
      processed: 3, skipped: 1, deleted: 0, total: 4,
      errors: [], started_at: new Date("2026-07-01T10:00:00Z"), finished_at: null,
    }]);
    const status = await getReindexJobStatus(ENV, USER_ID, "job-1");
    expect(status).toMatchObject({ job_id: "job-1", status: "running", processed: 3, total: 4, finished_at: null });
  });
});

describe("startReindexJob", () => {
  it("returns cooldown when a recent job already exists", async () => {
    queryQueue.push([{ id: "job-1", status: "running", started_at: new Date() }]);
    const result = await startReindexJob(ENV, USER_ID, "DS-my-strategy");
    expect(result.status).toBe("cooldown");
    expect(result.job_id).toBe("job-1");
  });

  it("fails fast when REINDEX_QUEUE binding is missing", async () => {
    queryQueue.push([]); // no recent job
    const result = await startReindexJob(ENV, USER_ID, "DS-my-strategy"); // ENV has no REINDEX_QUEUE
    expect(result.status).toBe("failed");
    expect(result.message).toContain("REINDEX_QUEUE binding missing");
  });
});

describe("handleWatchdog", () => {
  it("skips without DATABASE_URL, without querying", async () => {
    await handleWatchdog({});
    expect(queryQueue).toHaveLength(0);
  });

  it("marks stale running jobs failed", async () => {
    queryQueue.push([{ id: "job-1", user_id: USER_ID, source: "DS-my-strategy", completed_batches: 1, expected_batches: 3 }]);
    await expect(handleWatchdog(ENV)).resolves.toBeUndefined();
  });

  it("uses 30 minutes as the default stale threshold, not the old 60", async () => {
    queryQueue.push([]);
    await handleWatchdog(ENV);
    // args: [strings, sql.unsafe(tableName), staleMinutes] — table name is interpolated first.
    const [, , staleMinutes] = sqlCalls[sqlCalls.length - 1] as [unknown, string, number];
    expect(staleMinutes).toBe(30);
  });

  it("honors WATCHDOG_STALE_MINUTES override", async () => {
    queryQueue.push([]);
    await handleWatchdog({ ...ENV, WATCHDOG_STALE_MINUTES: "45" });
    const [, , staleMinutes] = sqlCalls[sqlCalls.length - 1] as [unknown, string, number];
    expect(staleMinutes).toBe(45);
  });
});

describe("handleQueue", () => {
  function makeMessage(overrides: Partial<ReindexBatchMessage> = {}) {
    const body: ReindexBatchMessage = {
      job_id: "job-1", user_id: USER_ID, source: "DS-my-strategy",
      files: [{ path: "note.md", action: "modified" }],
      ...overrides,
    };
    return { body, ack: vi.fn(), retry: vi.fn(), attempts: 1 };
  }

  function makeBatch(messages: ReturnType<typeof makeMessage>[]) {
    return { messages, queue: "reindex", ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<ReindexBatchMessage>;
  }

  it("acks and skips a message whose job no longer exists", async () => {
    queryQueue.push([]); // SELECT status → not found
    const msg = makeMessage();
    await handleQueue(makeBatch([msg]), ENV);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it("acks and skips a message whose job is no longer running", async () => {
    queryQueue.push([{ status: "failed" }]); // SELECT status
    const msg = makeMessage();
    await handleQueue(makeBatch([msg]), ENV);
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it("retries a message when its own job-update query fails", async () => {
    queryQueue.push([{ status: "running" }]); // SELECT status
    queryQueue.push([sourceRow()]); // resolveUserContext inside personalReindexFiles
    queryQueue.push(new Error("connection reset")); // UPDATE ... RETURNING throws

    const msg = makeMessage({ files: [] }); // empty batch — personalReindexFiles no-ops, no further DB/fetch calls
    await handleQueue(makeBatch([msg]), ENV);
    expect(msg.retry).toHaveBeenCalledOnce();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it("processes the rest of the batch independently when one message throws", async () => {
    queryQueue.push(new Error("connection reset")); // msg1's SELECT status throws
    queryQueue.push([]); // msg2's SELECT status → job not found

    const msg1 = makeMessage({ job_id: "job-1" });
    const msg2 = makeMessage({ job_id: "job-2" });
    await handleQueue(makeBatch([msg1, msg2]), ENV);

    expect(msg1.retry).toHaveBeenCalledOnce();
    expect(msg1.ack).not.toHaveBeenCalled();
    expect(msg2.ack).toHaveBeenCalledOnce();
    expect(msg2.retry).not.toHaveBeenCalled();
  });

  it("acks and marks the job succeeded once the last batch completes", async () => {
    queryQueue.push([{ status: "running" }]); // SELECT status
    queryQueue.push([sourceRow()]); // resolveUserContext
    queryQueue.push([]); // DELETE (removed action)
    queryQueue.push([{ completed_batches: 2, expected_batches: 2 }]); // UPDATE ... RETURNING
    queryQueue.push([]); // final UPDATE status='succeeded' (no RETURNING consumed)

    const msg = makeMessage({ files: [{ path: "gone.md", action: "removed" }] });
    await handleQueue(makeBatch([msg]), ENV);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });
});
