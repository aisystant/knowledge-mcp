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
  startIncrementalReindexJob,
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

describe("generation fencing (WP-560 Ф3)", () => {
  it("personalReindexFiles publishes nothing and reports stale when the source moved to a newer generation", async () => {
    queryQueue.push([sourceRow()]); // resolveUserContext (includeReindexing)
    queryQueue.push([{ index_generation: "4" }]); // current generation ≠ job's 3
    const result = await personalReindexFiles(ENV, {
      source: "DS-my-strategy", user_id: USER_ID, generation: 3,
      files: [{ path: "gone.md", action: "removed" }],
    });
    expect(result.stale).toBe(true);
    expect(result.deleted).toBe(0);
    expect(sqlCalls.some(([t]) => (t as TemplateStringsArray).join(" ").includes("DELETE"))).toBe(false);
  });

  it("a fenced job's removal runs with the 1/COUNT fence as the first statement of the transaction", async () => {
    queryQueue.push([sourceRow()]); // resolveUserContext
    queryQueue.push([{ index_generation: 3 }]); // pre-check passes
    queryQueue.push([{ fence: 1 }]); // fence statement
    queryQueue.push([]); // DELETE documents
    queryQueue.push([]); // DELETE status
    const result = await personalReindexFiles(ENV, {
      source: "DS-my-strategy", user_id: USER_ID, generation: 3,
      files: [{ path: "gone.md", action: "removed" }],
    });
    expect(result.stale).toBe(false);
    expect(result.deleted).toBe(1);
    const fence = latestSqlCallContaining("AS fence") as unknown[];
    expect((fence[0] as TemplateStringsArray).join(" ")).toContain("index_generation =");
    expect(fence[4]).toBe(3); // params: [table, userId, source, generation]
  });

  it("a fence violation mid-batch (division by zero) stops the batch as stale, not as a per-file error", async () => {
    queryQueue.push([sourceRow()]); // resolveUserContext
    queryQueue.push([{ index_generation: 3 }]); // pre-check passes (race: bump happens right after)
    queryQueue.push(new Error("division by zero")); // fence raises inside the transaction
    const result = await personalReindexFiles(ENV, {
      source: "DS-my-strategy", user_id: USER_ID, generation: 3,
      files: [{ path: "gone.md", action: "removed" }, { path: "other.md", action: "removed" }],
    });
    expect(result.stale).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.deleted).toBe(0);
  });

  it("legacy job without generation is unfenced (no pre-check, no fence statement)", async () => {
    queryQueue.push([sourceRow()]); // resolveUserContext
    queryQueue.push([]); // DELETE documents
    queryQueue.push([]); // DELETE status
    const result = await personalReindexFiles(ENV, {
      source: "DS-my-strategy", user_id: USER_ID, generation: null,
      files: [{ path: "gone.md", action: "removed" }],
    });
    expect(result.deleted).toBe(1);
    expect(sqlCalls.some(([t]) => (t as TemplateStringsArray).join(" ").includes("AS fence"))).toBe(false);
  });

  it("handleQueue cancels and acks a superseded job instead of retrying it", async () => {
    queryQueue.push([{ status: "running", generation: "3" }]); // SELECT status, generation
    queryQueue.push([sourceRow()]); // resolveUserContext
    queryQueue.push([{ index_generation: 4 }]); // newer generation → stale
    queryQueue.push([]); // UPDATE reindex_jobs SET status='cancelled'
    const msg = { body: { job_id: "job-old", user_id: USER_ID, source: "DS-my-strategy", files: [{ path: "a.md", action: "removed" as const }] }, ack: vi.fn(), retry: vi.fn(), attempts: 1 };
    await handleQueue({ messages: [msg], queue: "reindex", ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<ReindexBatchMessage>, ENV);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    const cancel = latestSqlCallContaining("status = 'cancelled'") as unknown[];
    expect((cancel[0] as TemplateStringsArray).join(" ")).toContain("superseded_generation");
  });

  it("handleQueue marks the source ready (fenced on generation) when the last batch of a fenced job completes", async () => {
    queryQueue.push([{ status: "running", generation: 3, kind: "full", completed_batch_indexes: [] }]); // SELECT status, generation, kind, completed_batch_indexes
    queryQueue.push([sourceRow()]); // resolveUserContext
    queryQueue.push([{ index_generation: 3 }]); // pre-check
    queryQueue.push([{ fence: 1 }]); // fence
    queryQueue.push([]); // DELETE documents
    queryQueue.push([]); // DELETE status
    queryQueue.push([{ completed_batches: 1, expected_batches: 1 }]); // UPDATE ... RETURNING
    queryQueue.push([]); // status='succeeded'
    queryQueue.push([]); // user_sources index_state='ready'
    const msg = { body: { job_id: "job-3", user_id: USER_ID, source: "DS-my-strategy", files: [{ path: "a.md", action: "removed" as const }] }, ack: vi.fn(), retry: vi.fn(), attempts: 1 };
    await handleQueue({ messages: [msg], queue: "reindex", ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<ReindexBatchMessage>, ENV);
    expect(msg.ack).toHaveBeenCalledOnce();
    const ready = latestSqlCallContaining("index_state = 'reindexing' AND index_generation =") as unknown[];
    expect(ready[2]).toBe("ready"); // params: [table, state, userId, source, generation]
    expect(ready[5]).toBe(3);
  });

  it("startReindexJob with a pre-created rebind job skips cooldown and reads the job's generation", async () => {
    queryQueue.push([{ id: "job-rebind", generation: "2", status: "pending" }]); // SELECT job
    queryQueue.push([sourceRow()]); // resolveUserContext (includeReindexing)
    queryQueue.push([]); // UPDATE running (0 files)
    queryQueue.push([]); // UPDATE succeeded
    queryQueue.push([]); // user_sources index_state='ready' (fenced)
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const env = { ...ENV, REINDEX_QUEUE: { sendBatch: vi.fn() } as unknown as Queue<ReindexBatchMessage> };

    const result = await startReindexJob(env, USER_ID, "DS-my-strategy", { jobId: "job-rebind" });

    expect(result.status).toBe("running");
    expect(result.job_id).toBe("job-rebind");
    expect(sqlCalls.some(([t]) => (t as TemplateStringsArray).join(" ").includes("INTERVAL '1 second'"))).toBe(false); // no cooldown query
    const ready = latestSqlCallContaining("index_state = 'reindexing' AND index_generation =") as unknown[];
    expect(ready[5]).toBe(2);
    globalThis.fetch = originalFetch;
  });

  it("startReindexJob fails cleanly when the pre-created job does not exist", async () => {
    queryQueue.push([]); // SELECT job → none
    const env = { ...ENV, REINDEX_QUEUE: { sendBatch: vi.fn() } as unknown as Queue<ReindexBatchMessage> };
    const result = await startReindexJob(env, USER_ID, "DS-my-strategy", { jobId: "job-gone" });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("job-gone");
  });

  it("startReindexJob treats an already-running pre-created job as idempotent (cooldown), not failure", async () => {
    queryQueue.push([{ id: "job-dup", generation: 2, status: "running" }]);
    const env = { ...ENV, REINDEX_QUEUE: { sendBatch: vi.fn() } as unknown as Queue<ReindexBatchMessage> };
    const result = await startReindexJob(env, USER_ID, "DS-my-strategy", { jobId: "job-dup" });
    expect(result.status).toBe("cooldown");
    expect(result.message).toContain("already running");
  });

  it("a DB failure before the pre-created job starts leaves job 'failed' and the source 'failed' (fenced on the job's generation)", async () => {
    queryQueue.push(new Error("connection reset")); // SELECT job throws
    queryQueue.push([]); // UPDATE reindex_jobs failed
    queryQueue.push([]); // UPDATE user_sources ... FROM reindex_jobs (fenced)
    const env = { ...ENV, REINDEX_QUEUE: { sendBatch: vi.fn() } as unknown as Queue<ReindexBatchMessage> };
    const result = await startReindexJob(env, USER_ID, "DS-my-strategy", { jobId: "job-net" });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("connection reset");
    const failed = latestSqlCallContaining("u.index_generation = j.generation") as unknown[];
    expect((failed[0] as TemplateStringsArray).join(" ")).toContain("index_state = 'failed'");
  });

  it("error-status writes of a fenced job go through the fence too", async () => {
    queryQueue.push([sourceRow()]); // resolveUserContext
    queryQueue.push([{ index_generation: 3 }]); // pre-check
    queryQueue.push([{ fence: 1 }]); // fence
    queryQueue.push([]); // error-status upsert
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) }); // readFromGitHub fails
    const result = await personalReindexFiles(ENV, {
      source: "DS-my-strategy", user_id: USER_ID, generation: 3,
      files: [{ path: "broken.md", action: "modified" }],
    });
    globalThis.fetch = originalFetch;
    expect(result.errors).toHaveLength(1);
    const status = latestSqlCallContaining("'error'") as unknown[];
    expect(status).toBeDefined();
    const fenceIdx = sqlCalls.findIndex(([t]) => (t as TemplateStringsArray).join(" ").includes("AS fence"));
    const statusIdx = sqlCalls.findIndex(([t]) => (t as TemplateStringsArray).join(" ").includes("'error'"));
    expect(fenceIdx).toBeGreaterThan(-1);
    expect(fenceIdx).toBeLessThan(statusIdx);
  });

  it("watchdog also fails 'pending' jobs nobody ever started and marks their sources 'failed'", async () => {
    queryQueue.push([]); // stale running → none
    queryQueue.push([{ id: "job-p", user_id: USER_ID, source: "DS-my-strategy", generation: 4, kind: "full" }]); // abandoned pending
    queryQueue.push([]); // setSourceIndexState failed
    await handleWatchdog(ENV);
    const abandoned = latestSqlCallContaining("watchdog_pending_never_started") as unknown[];
    expect((abandoned[0] as TemplateStringsArray).join(" ")).toContain("status = 'pending'");
    const failed = latestSqlCallContaining("index_state = 'reindexing' AND index_generation =") as unknown[];
    expect(failed[2]).toBe("failed");
    expect(failed[5]).toBe(4);
  });

  it("new jobs carry the source's current generation", async () => {
    queryQueue.push([]); // no recent job
    queryQueue.push([{ id: "job-new", generation: 7 }]); // INSERT ... SELECT index_generation ... RETURNING
    queryQueue.push([sourceRow()]); // resolveUserContext
    queryQueue.push([]); // UPDATE running (0 files)
    queryQueue.push([]); // UPDATE succeeded
    queryQueue.push([]); // ready (fenced, generation 7)
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const env = { ...ENV, REINDEX_QUEUE: { sendBatch: vi.fn() } as unknown as Queue<ReindexBatchMessage> };
    await startReindexJob(env, USER_ID, "DS-my-strategy");
    const insert = latestSqlCallContaining("(user_id, source, status, generation)") as unknown[];
    expect((insert[0] as TemplateStringsArray).join(" ")).toContain("SELECT");
    expect((insert[0] as TemplateStringsArray).join(" ")).toContain("index_generation");
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
      batch_index: 0,
      kind: "incremental",
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

  it("acks and marks the job succeeded once the last batch completes, WITHOUT touching index_state (kind='incremental')", async () => {
    // WP-545 Ф13 cold review (Medium finding): this is the negative counterpart to "handleQueue
    // marks the source ready (fenced on generation)..." above — that test proves kind='full'
    // DOES flip index_state; this one proves kind='incremental' (this suite's default, via
    // makeMessage/jobRows both omitting `kind`) must NOT, even on a real last-batch completion.
    queryQueue.push([{ status: "running", generation: 3, kind: "incremental", completed_batch_indexes: [] }]); // SELECT status
    queryQueue.push([sourceRow()]); // resolveUserContext
    queryQueue.push([]); // DELETE (removed action)
    queryQueue.push([{ completed_batches: 2, expected_batches: 2 }]); // UPDATE ... RETURNING
    queryQueue.push([]); // final UPDATE status='succeeded' (no RETURNING consumed)

    const msg = makeMessage({ files: [{ path: "gone.md", action: "removed" }] });
    await handleQueue(makeBatch([msg]), ENV);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(sqlCalls.some(([t]) => (t as TemplateStringsArray).join(" ").includes("index_state = 'reindexing' AND index_generation ="))).toBe(false);
  });

  it("watchdog never touches index_state for a stale or abandoned kind='incremental' job", async () => {
    // Negative counterpart to the two existing "marks stale/abandoned jobs failed" tests —
    // those don't assert on index_state at all; this one explicitly proves the kind gate holds
    // for both the stale-running and abandoned-pending branches (WP-545 Ф13 cold review).
    queryQueue.push([{ id: "job-stale-inc", user_id: USER_ID, source: "DS-my-strategy", kind: "incremental", generation: 1, completed_batches: 1, expected_batches: 3 }]); // stale running
    queryQueue.push([{ id: "job-pending-inc", user_id: USER_ID, source: "DS-my-strategy", kind: "incremental", generation: 1 }]); // abandoned pending
    await handleWatchdog(ENV);
    expect(sqlCalls.some(([t]) => (t as TemplateStringsArray).join(" ").includes("index_state = 'reindexing' AND index_generation ="))).toBe(false);
  });
});

describe("startIncrementalReindexJob (WP-545 Ф13)", () => {
  // Fresh REINDEX_QUEUE mock per test — a shared const here would leak call counts across
  // tests in this describe block (the top-level beforeEach only resets queryQueue/sqlCalls).
  function queueEnv(): ReindexEnv {
    return { ...ENV, REINDEX_QUEUE: { sendBatch: vi.fn() } as unknown as ReindexEnv["REINDEX_QUEUE"] };
  }

  it("skips without touching the DB when no pushed file is indexable", async () => {
    const result = await startIncrementalReindexJob(queueEnv(), USER_ID, "DS-my-strategy", [
      { path: "image.png", action: "modified" },
    ]);
    expect(result).toMatchObject({ status: "skipped", reason: "no_indexable_files" });
    expect(sqlCalls).toHaveLength(0);
  });

  it("rejects a path-traversal file without touching the DB, alongside real files", async () => {
    queryQueue.push([{ active: true, auto_reindex_enabled: true }]); // probe
    queryQueue.push([{ id: "job-inc-1", generation: 5 }]); // INSERT ... RETURNING
    queryQueue.push([]); // UPDATE running

    const result = await startIncrementalReindexJob(queueEnv(), USER_ID, "DS-my-strategy", [
      { path: "note.md", action: "modified" },
      { path: "../escape.md", action: "modified" },
    ]);
    expect(result.status).toBe("queued");
    expect(result.rejected_paths).toBeUndefined(); // rejection is only reported on the skip path today
  });

  it("creates an incremental job and enqueues to REINDEX_QUEUE for an active, enabled source", async () => {
    queryQueue.push([{ active: true, auto_reindex_enabled: true }]); // probe
    queryQueue.push([{ id: "job-inc-2", generation: 5 }]); // INSERT ... SELECT ... RETURNING
    queryQueue.push([]); // UPDATE running

    const env = queueEnv();
    const result = await startIncrementalReindexJob(env, USER_ID, "DS-my-strategy", [
      { path: "note.md", action: "modified" },
    ]);

    expect(result).toMatchObject({ status: "queued", job_id: "job-inc-2" });
    expect(env.REINDEX_QUEUE!.sendBatch).toHaveBeenCalledOnce();
    const [sentBatch] = vi.mocked(env.REINDEX_QUEUE!.sendBatch).mock.calls[0] as [{ body: ReindexBatchMessage }[]];
    expect(sentBatch[0].body).toMatchObject({ job_id: "job-inc-2", kind: "incremental", batch_index: 0 });

    const insertCall = latestSqlCallContaining("kind") as unknown[];
    expect((insertCall[0] as TemplateStringsArray).join(" ")).toContain("INSERT INTO");
  });

  it("skips with source_not_active_for_user when the source row doesn't exist", async () => {
    queryQueue.push([]); // probe: no row
    queryQueue.push([]); // INSERT ... RETURNING: 0 rows (WHERE active/auto_reindex_enabled doesn't match)

    const result = await startIncrementalReindexJob(queueEnv(), USER_ID, "DS-my-strategy", [
      { path: "note.md", action: "modified" },
    ]);
    expect(result).toMatchObject({ status: "skipped", reason: "source_not_active_for_user" });
  });

  it("skips with auto_reindex_disabled when the source is active but opted out", async () => {
    queryQueue.push([{ active: true, auto_reindex_enabled: false }]); // probe
    queryQueue.push([]); // INSERT ... RETURNING: 0 rows

    const result = await startIncrementalReindexJob(queueEnv(), USER_ID, "DS-my-strategy", [
      { path: "note.md", action: "modified" },
    ]);
    expect(result).toMatchObject({ status: "skipped", reason: "auto_reindex_disabled" });
  });

  it("falls back to state_changed_during_check when the atomic insert disagrees with the earlier probe (TOCTOU)", async () => {
    // The probe read "active" a moment before a concurrent disconnect flipped it — the
    // informational SELECT is stale, but the atomic INSERT...SELECT...RETURNING is still the
    // authoritative gate and correctly returns no job.
    queryQueue.push([{ active: true, auto_reindex_enabled: true }]); // probe (now stale)
    queryQueue.push([]); // INSERT ... RETURNING: 0 rows (source deactivated in the gap)

    const result = await startIncrementalReindexJob(queueEnv(), USER_ID, "DS-my-strategy", [
      { path: "note.md", action: "modified" },
    ]);
    expect(result).toMatchObject({ status: "skipped", reason: "state_changed_during_check" });
  });

  it("marks the job failed, never the source's index_state, when enqueueing throws", async () => {
    queryQueue.push([{ active: true, auto_reindex_enabled: true }]); // probe
    queryQueue.push([{ id: "job-inc-3", generation: 5 }]); // INSERT ... RETURNING
    queryQueue.push(new Error("connection reset")); // UPDATE running throws

    const result = await startIncrementalReindexJob(queueEnv(), USER_ID, "DS-my-strategy", [
      { path: "note.md", action: "modified" },
    ]);
    expect(result).toMatchObject({ status: "failed", job_id: "job-inc-3" });
    // Only the job row got a failure UPDATE — user_sources.index_state was never touched
    // (kind='incremental' never gates that call in the first place).
    expect(sqlCalls.some(([t]) => (t as TemplateStringsArray).join(" ").includes("index_state = 'failed'"))).toBe(false);
  });
});
