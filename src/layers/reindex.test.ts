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
  relativeMarkdownPathsFromTree,
  chunkContent,
  contentHash,
  mapWithConcurrency,
  type ReindexEnv,
  type ReindexBatchMessage,
} from "./reindex.js";
import { assertIndexablePath, getInstallationToken } from "./personal.js";

beforeEach(() => {
  queryQueue = [];
  sqlCalls = [];
  vi.mocked(getInstallationToken).mockClear();
});

const ENV: ReindexEnv = {
  DATABASE_URL: "postgres://fake",
  OPENROUTER_API_KEY: "fake-key",
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "fake",
};

const USER_ID = "11111111-1111-1111-1111-111111111111";

function sourceRow(pathPrefix: string = "") {
  return { source: "DS-my-strategy", github_owner: "TserenTserenov", github_repo: "DS-my-strategy", path_prefix: pathPrefix, source_type: "ds" };
}

function latestSqlCallContaining(fragment: string): unknown[] {
  const call = [...sqlCalls].reverse().find(([template]) =>
    (template as TemplateStringsArray).join(" ").includes(fragment)
  );
  if (!call) throw new Error(`SQL call containing ${fragment} not found`);
  return call;
}

/** Like latestSqlCallContaining, but disambiguates between the two DELETE
 * statements a `removed` action now issues (WP-7 Ф97.2): documents and
 * file_index_status share the "DELETE" fragment, so this also matches on
 * the qualified table name (the mock's `sql.unsafe` passes it through as
 * the call's first value, verbatim). */
function latestSqlCallContainingForTable(fragment: string, tableFragment: string): unknown[] {
  const call = [...sqlCalls].reverse().find(([template, ...values]) =>
    (template as TemplateStringsArray).join(" ").includes(fragment) &&
    values.some(v => typeof v === "string" && v.includes(tableFragment))
  );
  if (!call) throw new Error(`SQL call containing ${fragment} for table ${tableFragment} not found`);
  return call;
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
    // WP-7 Ф98: the structured mirror carries the same failure with path "*" (source-level).
    expect(result.error_details).toEqual([
      { path: "*", action: "n/a", reason: "missing user_id: authenticated user context required" },
    ]);
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

  it.each(["a\\b.md", "\\a.md"])("rejects invalid path %s before GitHub fetch", async path => {
    queryQueue.push([sourceRow()]); // resolveUserContext
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();

    const result = await personalReindexFiles(ENV, {
      source: "DS-my-strategy", files: [{ path, action: "modified" }], user_id: USER_ID,
    });

    expect(result.errors[0]).toContain("must be relative");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    globalThis.fetch = originalFetch;
  });

  it("deletes on action=removed without reading GitHub", async () => {
    queryQueue.push([sourceRow()]); // resolveUserContext
    queryQueue.push([]); // DELETE documents result (ignored)
    queryQueue.push([]); // DELETE file_index_status result (ignored) — WP-7 Ф97.2
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();
    const path = "gone%_file.md";
    const result = await personalReindexFiles(ENV, {
      source: "DS-my-strategy", files: [{ path, action: "removed" }], user_id: USER_ID,
    });
    expect(result.deleted).toBe(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const [docTemplate, ...docValues] = latestSqlCallContainingForTable("DELETE", "knowledge.documents") as [TemplateStringsArray, ...unknown[]];
    expect(docTemplate.join(" ")).not.toContain(" LIKE ");
    expect(docValues).toContain(path);
    expect(docValues).toContain(`${path}::`);
    // WP-7 Ф97.2: the removed action must also delete the status row, in the
    // same transaction — otherwise a deleted file keeps reporting 'indexed'.
    const [, ...statusValues] = latestSqlCallContainingForTable("DELETE", "knowledge.file_index_status") as [TemplateStringsArray, ...unknown[]];
    expect(statusValues).toContain(USER_ID);
    expect(statusValues).toContain("DS-my-strategy");
    expect(statusValues).toContain(path);
    globalThis.fetch = originalFetch;
  });

  it.each(["vault", "vault/"])("reads an exact encoded URL with pathPrefix %s", async pathPrefix => {
    const hash = await contentHash("unchanged content");
    const path = "docs/cafe\u0301_%#? file.md";
    queryQueue.push([sourceRow(pathPrefix)]); // resolveUserContext
    queryQueue.push([{ hash, protocol_version: 2 }]); // hash check — matches, already backfilled (merged Ф94 skip needs v2)

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: true, text: async () => "unchanged content" }); // file content

    const result = await personalReindexFiles(ENV, {
      source: "DS-my-strategy", files: [{ path, action: "modified" }], user_id: USER_ID,
    });
    expect(result.skipped).toBe(1);
    expect(result.processed).toBe(0);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/TserenTserenov/DS-my-strategy/contents/" +
      "vault/docs/cafe%CC%81_%25%23%3F%20file.md",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/vnd.github.raw+json" }) }),
    );
    globalThis.fetch = originalFetch;
  });

  it("rejects an invalid configured prefix before token acquisition or fetch", async () => {
    queryQueue.push([sourceRow("../outside")]); // resolveUserContext
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();

    const result = await personalReindexFiles(ENV, {
      source: "DS-my-strategy",
      files: [{ path: "note.md", action: "modified" }],
      user_id: USER_ID,
    });

    expect(result.errors[0]).toContain("escape the repository root");
    expect(getInstallationToken).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
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
    const path = "note%_file.md";
    queryQueue.push([sourceRow()]); // resolveUserContext
    queryQueue.push([{ hash: "0000000000000000" }]); // hash check — different, proceed
    queryQueue.push([]); // DELETE old chunks
    queryQueue.push([]); // INSERT result (ignored)
    queryQueue.push([]); // UPSERT file_index_status success (ignored) — WP-7 Ф97.2

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => "new content" })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) }); // embedding

    const result = await personalReindexFiles(ENV, {
      source: "DS-my-strategy", files: [{ path, action: "modified" }], user_id: USER_ID,
    });
    expect(result.processed).toBe(1);
    expect(result.errors).toEqual([]);
    const [template, ...values] = latestSqlCallContaining("DELETE") as [TemplateStringsArray, ...unknown[]];
    expect(template.join(" ")).not.toContain(" LIKE ");
    expect(values).toContain(path);
    expect(values).toContain(`${path}::`);
    // WP-7 Ф97.2: the success status upsert must be part of the SAME
    // transaction array as the chunk delete/insert (closes the split-
    // transaction race — peer-session 2026-08-30-18, round 1).
    const [statusTemplate, ...statusValues] = latestSqlCallContainingForTable("INSERT", "knowledge.file_index_status") as [TemplateStringsArray, ...unknown[]];
    expect(statusTemplate.join(" ")).toContain("'indexed'");
    expect(statusValues).toContain(path);
    globalThis.fetch = originalFetch;
  });
});

describe("relativeMarkdownPathsFromTree", () => {
  const tree = [
    { path: "docs/a.md", mode: "100644", type: "blob" as const, sha: "a" },
    { path: "docs/deep/b.md", mode: "100644", type: "blob" as const, sha: "b" },
    { path: "docs2/bypass.md", mode: "100644", type: "blob" as const, sha: "c" },
    { path: "docs/image.png", mode: "100644", type: "blob" as const, sha: "d" },
  ];

  it.each(["docs", "docs/"])("uses a segment boundary for prefix %s", pathPrefix => {
    expect(relativeMarkdownPathsFromTree(tree, pathPrefix)).toEqual(["a.md", "deep/b.md"]);
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

  it("looks up and segment-encodes the repository default branch before reading its tree", async () => {
    queryQueue.push([]); // no recent job
    queryQueue.push([{ id: "job-branch" }]); // INSERT reindex job
    queryQueue.push([sourceRow("docs/")]); // resolveUserContext
    queryQueue.push([]); // UPDATE running

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ default_branch: "feature/a" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ commit: { sha: "a".repeat(40) } }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tree: [
            { path: "docs/note.md", mode: "100644", type: "blob", sha: "b".repeat(40) },
            { path: "docs2/bypass.md", mode: "100644", type: "blob", sha: "c".repeat(40) },
          ],
        }),
      });
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const env = {
      ...ENV,
      REINDEX_QUEUE: { sendBatch } as unknown as Queue<ReindexBatchMessage>,
    };

    const result = await startReindexJob(env, USER_ID, "DS-my-strategy");

    expect(result.status).toBe("running");
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/TserenTserenov/DS-my-strategy/branches/feature%2Fa",
      expect.any(Object),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      3,
      `https://api.github.com/repos/TserenTserenov/DS-my-strategy/git/trees/${"a".repeat(40)}?recursive=1`,
      expect.any(Object),
    );
    expect(sendBatch).toHaveBeenCalledWith([
      expect.objectContaining({ body: expect.objectContaining({ files: [{ path: "note.md", action: "modified" }] }) }),
    ]);
    globalThis.fetch = originalFetch;
  });

  it("stops tree lookup when repository metadata has no default branch", async () => {
    queryQueue.push([]); // no recent job
    queryQueue.push([{ id: "job-no-default" }]); // INSERT reindex job
    queryQueue.push([sourceRow("docs")]); // resolveUserContext
    queryQueue.push([]); // UPDATE running
    queryQueue.push([]); // UPDATE succeeded for zero files

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const sendBatch = vi.fn();
    const env = {
      ...ENV,
      REINDEX_QUEUE: { sendBatch } as unknown as Queue<ReindexBatchMessage>,
    };

    const result = await startReindexJob(env, USER_ID, "DS-my-strategy");

    expect(result.message).toContain("No files");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(sendBatch).not.toHaveBeenCalled();
    globalThis.fetch = originalFetch;
  });

  it("rejects an invalid tree prefix before token acquisition or GitHub fetch", async () => {
    queryQueue.push([]); // no recent job
    queryQueue.push([{ id: "job-invalid-prefix" }]); // INSERT reindex job
    queryQueue.push([sourceRow("../outside")]); // resolveUserContext
    queryQueue.push([]); // UPDATE running with zero files
    queryQueue.push([]); // UPDATE succeeded

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();
    const sendBatch = vi.fn();
    const env = {
      ...ENV,
      REINDEX_QUEUE: { sendBatch } as unknown as Queue<ReindexBatchMessage>,
    };

    const result = await startReindexJob(env, USER_ID, "DS-my-strategy");

    expect(result.message).toContain("No files");
    expect(getInstallationToken).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(sendBatch).not.toHaveBeenCalled();
    globalThis.fetch = originalFetch;
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
