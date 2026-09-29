/**
 * Integration tests for the batched full-ingest path (WP-532 Ф9) against a REAL PostgreSQL.
 *
 * The unit tests in index.test.ts cover pure helpers only. The bugs that made the first version of
 * this path unable to complete — a swap that omitted the NOT NULL chunk_id column, an unguarded
 * DELETE that erased a run's own staging rows after every lost CAS, a single sendBatch of 590
 * messages — are all in SQL and queue plumbing that mocks cannot see. These tests run the real
 * worker entry points (POST /full-ingest, queue(), the sweep) with @neondatabase/serverless
 * replaced by a thin adapter over `pg`, so every statement in the module executes on Postgres.
 *
 * Skipped unless FULL_INGEST_PG_URL is set. It must point at a LOOPBACK database created for the
 * purpose: the suite DROPs and recreates schema `public` there, and refuses any other host.
 *
 *   initdb -D /tmp/kmtest -U postgres --auth=trust && pg_ctl -D /tmp/kmtest -o "-p 54329 \
 *     -c listen_addresses=127.0.0.1" start && createdb -h 127.0.0.1 -p 54329 -U postgres kmtest
 *   npm i --no-save pg
 *   FULL_INGEST_PG_URL=postgres://postgres@127.0.0.1:54329/kmtest npx vitest run src/full-ingest.pg.test.ts
 *
 * Optional: FULL_INGEST_REAL_DOC=/path/to/FPF-Spec.md also runs the whole pipeline on the real
 * 15.6 MB document (5896 chunks). The schema fixture is src/test-support/full-ingest-schema.sql
 * (see its header for provenance and the two deliberate deviations from production).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import worker, { abandonStaleFullIngestRuns } from "./index.js";
import type { Env } from "./index.js";

const PG_URL = process.env.FULL_INGEST_PG_URL;
const REAL_DOC = process.env.FULL_INGEST_REAL_DOC;

// vi.mock is hoisted above the imports, so everything its factory needs lives in vi.hoisted.
const pgAdapter = vi.hoisted(() => {
  const holder: { pool: any; afterTransaction: (() => Promise<void>) | null } = { pool: null, afterTransaction: null };

  class Raw {
    constructor(readonly text: string) {}
  }

  function build(strings: TemplateStringsArray, values: unknown[]) {
    let text = "";
    const params: unknown[] = [];
    for (let i = 0; i < strings.length; i++) {
      text += strings[i];
      if (i < values.length) {
        const value = values[i];
        if (value instanceof Raw) {
          text += value.text;
        } else {
          params.push(value);
          text += "$" + params.length;
        }
      }
    }
    return { text, params };
  }

  /** Mimics the parts of the neon() HTTP client this module uses: a lazy tagged template,
   *  sql.unsafe(), and sql.transaction([...]) as one BEGIN/COMMIT on a single connection. */
  function make() {
    const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = build(strings, values);
      return {
        __query: query,
        then(resolveFn: any, rejectFn: any) {
          return holder.pool.query(query.text, query.params).then((r: any) => r.rows).then(resolveFn, rejectFn);
        },
      };
    };
    sql.unsafe = (text: string) => new Raw(text);
    sql.transaction = async (queries: any[]) => {
      const client = await holder.pool.connect();
      try {
        await client.query("BEGIN");
        const out: unknown[] = [];
        for (const q of queries) out.push((await client.query(q.__query.text, q.__query.params)).rows);
        await client.query("COMMIT");
        if (holder.afterTransaction) await holder.afterTransaction();
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    };
    return sql;
  }
  return { holder, make };
});

vi.mock("@neondatabase/serverless", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@neondatabase/serverless")>();
  return { ...actual, neon: () => pgAdapter.make() };
});

const SOURCE = "FPF";
const DOC = "FPF-Spec.md";
const QUEUE_NAME = "full-ingest-batches";
const SECRET = "test-reindex-secret";

interface QueueMock {
  sent: any[];
  calls: number;
  sendBatch: (msgs: { body: any }[]) => Promise<void>;
}

function makeQueue(failOnCall?: number): QueueMock {
  const queue: QueueMock = {
    sent: [],
    calls: 0,
    sendBatch: async (msgs) => {
      queue.calls++;
      if (failOnCall !== undefined && queue.calls === failOnCall) throw new Error("queue unavailable");
      queue.sent.push(...msgs.map((m) => m.body));
    },
  };
  return queue;
}

function makeEnv(extra: Record<string, unknown> = {}): Env {
  return {
    KNOWLEDGE_DATABASE_URL: "postgres://unused/x",
    HEALTH_DATABASE_URL: "postgres://unused/x",
    KNOWLEDGE_DB_SCHEMA: "public",
    OPENROUTER_API_KEY: "test-key",
    REINDEX_SECRET: SECRET,
    ...extra,
  } as unknown as Env;
}

/** A markdown document whose chunkLargeFile() result is `sections + 1` chunks (intro + sections). */
function syntheticDoc(sections: number, titleOf: (i: number) => string = (i) => `Section ${i}`): string {
  let text = "# Test Spec\n\nIntro paragraph that is long enough to become a chunk of its own.\n\n";
  for (let i = 1; i <= sections; i++) {
    text += `## ${titleOf(i)}\n\n${"Body text of the section. ".repeat(30)}(${i})\n\n`;
  }
  return text;
}

interface FetchStub {
  blobFetches: number;
  embedCalls: number;
}

/** GitHub tree/blob and the embedding endpoint. The tree reports FPF-Spec.md as > 1 MB so the
 *  daily/manual path treats it as oversized whatever the (small) test body really is. */
function stubNetwork(doc: { sha: string; text: string }): FetchStub {
  const counters: FetchStub = { blobFetches: 0, embedCalls: 0 };
  vi.stubGlobal("fetch", vi.fn(async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://api.github.com/repos/ailev/FPF/git/trees/")) {
      return new Response(JSON.stringify({
        tree: [
          { path: DOC, type: "blob", size: 1_500_000, sha: doc.sha },
          { path: "README.md", type: "blob", size: 500, sha: "readme-sha" },
        ],
        truncated: false,
      }));
    }
    if (url.startsWith("https://api.github.com/repos/ailev/FPF/git/blobs/")) {
      counters.blobFetches++;
      return new Response(doc.text);
    }
    if (url === "https://openrouter.ai/api/v1/embeddings") {
      counters.embedCalls++;
      return new Response(JSON.stringify({ data: [{ embedding: [0.25, 0.5, 0.75] }] }));
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
  return counters;
}

async function postFullIngest(env: Env, body: Record<string, unknown>, secret: string | null = SECRET): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers.Authorization = `Bearer ${secret}`;
  const res = await worker.fetch(new Request("https://kb.test/full-ingest", { method: "POST", headers, body: JSON.stringify(body) }), env);
  return { status: res.status, json: await res.json() };
}

async function deliver(env: Env, bodies: any[]) {
  const batch = {
    queue: QUEUE_NAME,
    messages: bodies.map((body) => ({ id: crypto.randomUUID(), body, attempts: 1, timestamp: new Date(), ack: vi.fn(), retry: vi.fn() })),
  };
  await worker.queue(batch as any, env);
  return batch.messages;
}

const q = async (text: string, params: unknown[] = []) => (await pgAdapter.holder.pool.query(text, params)).rows as any[];

const liveDoc = (uri = DOC) =>
  q(
    `SELECT * FROM knowledge_chunk WHERE source = $1 AND account_id IS NULL AND (source_uri = $2 OR starts_with(source_uri, $2 || '::')) ORDER BY paragraph_pos`,
    [SOURCE, uri],
  );

async function seedOldEdition(): Promise<void> {
  const insert = (chunkId: string, uri: string, pos: number, content: string, account: string | null = null) =>
    q(
      `INSERT INTO knowledge_chunk (chunk_id, document_path, paragraph_pos, content_hash, source_uri, content, source, source_kind, hash, account_id, collection_kind)
       VALUES ($1, $2, $3, 'oldhash', $4, $5, $6, 'pack', 'oldhash', $7::uuid, $8)`,
      [chunkId, uri, pos, uri, content, SOURCE, account, account ? "personal" : "platform"],
    );
  await insert(`${DOC}::p0`, DOC, 0, "OLD parent");
  await insert(`${DOC}::Old A::p1`, `${DOC}::Old A`, 1, "OLD chunk A");
  await insert(`${DOC}::Old B::p2`, `${DOC}::Old B`, 2, "OLD chunk B");
  await insert("Other.md::p0", "Other.md", 0, "unrelated platform document");
  // Same source_uri as the swapped document but owned by a person: must never be touched.
  await insert(`${DOC}::p0`, DOC, 0, "PERSONAL copy", "11111111-1111-4111-8111-111111111111");
}

const stagingCount = async (runId?: string) =>
  (await q(runId ? `SELECT count(*)::int AS n FROM knowledge_chunk_staging WHERE run_id = $1` : `SELECT count(*)::int AS n FROM knowledge_chunk_staging`, runId ? [runId] : []))[0].n as number;

const runStatus = async (runId: string) => (await q(`SELECT status FROM full_ingest_runs WHERE run_id = $1`, [runId]))[0].status as string;

async function startRun(env: Env, doc: { sha: string; text: string }): Promise<{ runId: string; totalChunks: number; net: FetchStub }> {
  const net = stubNetwork(doc);
  const res = await postFullIngest(env, { source: SOURCE, path: DOC, dry_run: false });
  expect(res.status).toBe(200);
  expect(res.json.results[0].outcome).toBe("queued");
  return { runId: res.json.results[0].run_id, totalChunks: res.json.results[0].total_chunks, net };
}

describe.skipIf(!PG_URL)("batched full-ingest on real PostgreSQL (WP-532 Ф9)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    const url = new URL(PG_URL!);
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
      throw new Error(`refusing to run destructive tests against non-loopback host ${url.hostname}`);
    }
    const pgModule = "pg"; // dynamic on purpose: pg is a dev-time install (npm i --no-save pg), not a dependency
    const { Pool } = await import(pgModule);
    pgAdapter.holder.pool = new Pool({ connectionString: PG_URL, max: 8 });
    const fixture = readFileSync(resolve(__dirname, "test-support/full-ingest-schema.sql"), "utf8");
    await pgAdapter.holder.pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await pgAdapter.holder.pool.query(fixture);
  });

  afterAll(async () => {
    await pgAdapter.holder.pool?.end();
  });

  beforeEach(async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await q(`DELETE FROM full_ingest_runs`);
    await q(`DELETE FROM knowledge_chunk`);
  });

  afterEach(() => {
    pgAdapter.holder.afterTransaction = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const phases = () => logSpy.mock.calls.map((c: unknown[]) => { try { return JSON.parse(String(c[0])).phase; } catch { return null; } }).filter(Boolean);

  it("completes a multi-message run: nothing is lost mid-run, then one swap replaces the old edition", async () => {
    await seedOldEdition();
    const queue = makeQueue();
    const env = makeEnv({ FULL_INGEST_QUEUE: queue });
    const { runId, totalChunks } = await startRun(env, { sha: "sha-1", text: syntheticDoc(45) });
    expect(totalChunks).toBe(47);
    expect(queue.sent.length).toBe(5);
    // Everything is staged before the first message exists: the texts are frozen.
    expect(await stagingCount(runId)).toBe(47);
    expect((await q(`SELECT count(*)::int AS n FROM knowledge_chunk_staging WHERE run_id = $1 AND embedding IS NULL`, [runId]))[0].n).toBe(47);

    for (let i = 0; i < queue.sent.length - 1; i++) {
      const [msg] = await deliver(env, [queue.sent[i]]);
      expect(msg.ack).toHaveBeenCalledTimes(1);
      // The regression of the first design: a lost CAS must not erase staged work.
      expect(await stagingCount(runId)).toBe(47);
      // And the live document is still the OLD edition.
      expect((await liveDoc()).map((r) => r.content)).toContain("OLD parent");
    }

    await deliver(env, [queue.sent[queue.sent.length - 1]]);
    expect(await runStatus(runId)).toBe("swapped");
    expect(await stagingCount(runId)).toBe(0);

    const live = await liveDoc();
    expect(live.length).toBe(47);
    expect(live.some((r) => r.content.startsWith("OLD"))).toBe(false);
    expect(live.every((r) => r.chunk_id && r.collection_kind === "platform" && r.account_id === null)).toBe(true);
    const parent = live.find((r) => r.paragraph_pos === 0)!;
    expect(parent.chunk_uuid).toBe(runId);
    expect(parent.embedding).toBeNull();
    const children = live.filter((r) => r.paragraph_pos > 0);
    expect(children.every((r) => r.parent_chunk_id === parent.chunk_uuid && r.embedding !== null)).toBe(true);
    expect(new Set(live.map((r) => r.source_uri)).size).toBe(47);
    // Other documents and the personal copy are untouched.
    expect((await q(`SELECT content FROM knowledge_chunk WHERE source_uri = 'Other.md'`))[0].content).toBe("unrelated platform document");
    expect((await q(`SELECT content FROM knowledge_chunk WHERE account_id IS NOT NULL`))[0].content).toBe("PERSONAL copy");
    expect(phases().filter((p: string) => p === "full_ingest_swapped").length).toBe(1);
  });

  it("does not pay for embeddings twice when a message is delivered twice", async () => {
    const queue = makeQueue();
    const env = makeEnv({ FULL_INGEST_QUEUE: queue });
    const { net } = await startRun(env, { sha: "sha-2", text: syntheticDoc(25) });
    const first = queue.sent[0];
    await deliver(env, [first]);
    const afterFirst = net.embedCalls;
    expect(afterFirst).toBe(first.batch_end - first.batch_start);
    await deliver(env, [first]);
    expect(net.embedCalls).toBe(afterFirst);
  });

  it("exactly one of two concurrent last consumers swaps", async () => {
    const queue = makeQueue();
    const env = makeEnv({ FULL_INGEST_QUEUE: queue });
    const { runId } = await startRun(env, { sha: "sha-3", text: syntheticDoc(45) });
    for (const body of queue.sent.slice(0, -2)) await deliver(env, [body]);
    const [a, b] = queue.sent.slice(-2);
    await Promise.all([deliver(env, [a]), deliver(env, [b])]);
    expect(await runStatus(runId)).toBe("swapped");
    expect((await liveDoc()).length).toBe(47);
    expect(phases().filter((p: string) => p === "full_ingest_swapped").length).toBe(1);
  });

  it("waits for the advisory lock the manual loader takes, then swaps", async () => {
    const queue = makeQueue();
    const env = makeEnv({ FULL_INGEST_QUEUE: queue });
    const { runId } = await startRun(env, { sha: "sha-4", text: syntheticDoc(15) });
    for (const body of queue.sent.slice(0, -1)) await deliver(env, [body]);

    const holder = await pgAdapter.holder.pool.connect();
    await holder.query("BEGIN");
    await holder.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${SOURCE}::${DOC}`]);
    let finished = false;
    const pending = deliver(env, [queue.sent[queue.sent.length - 1]]).then(() => { finished = true; });
    await new Promise((r) => setTimeout(r, 600));
    expect(finished).toBe(false);
    expect(await runStatus(runId)).toBe("running");
    await holder.query("COMMIT");
    holder.release();
    await pending;
    expect(await runStatus(runId)).toBe("swapped");
  });

  it("a failed queue publish abandons the run and leaves no staging rows behind", async () => {
    const queue = makeQueue(2);
    const env = makeEnv({ FULL_INGEST_QUEUE: queue });
    stubNetwork({ sha: "sha-5", text: syntheticDoc(1050) });
    const res = await postFullIngest(env, { source: SOURCE, path: DOC, dry_run: false });
    expect(res.json.results[0].outcome).toBe("failed");
    expect(queue.calls).toBe(2);
    expect(queue.sent.length).toBe(100);
    const [run] = await q(`SELECT run_id, status FROM full_ingest_runs`);
    expect(run.status).toBe("abandoned");
    expect(await stagingCount()).toBe(0);
    // A message that already reached a consumer is acknowledged without any work.
    const net = stubNetwork({ sha: "sha-5", text: "" });
    const [msg] = await deliver(env, [queue.sent[0]]);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(net.embedCalls).toBe(0);
  });

  it("splits 100+ messages into several sendBatch calls, none above 100", async () => {
    const queue = makeQueue();
    const env = makeEnv({ FULL_INGEST_QUEUE: queue });
    const sizes: number[] = [];
    const original = queue.sendBatch;
    queue.sendBatch = async (msgs) => { sizes.push(msgs.length); await original(msgs); };
    await startRun(env, { sha: "sha-6", text: syntheticDoc(1050) });
    expect(sizes).toEqual([100, 6]);
    expect(queue.sent.length).toBe(106);
  });

  it("the sweep removes leftovers of abandoned runs and of stale running runs, and spares a fresh one", async () => {
    const ids = ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000003"];
    const stage = (runId: string) =>
      q(`INSERT INTO knowledge_chunk_staging (run_id, chunk_index, role, chunk_uuid, chunk_id, document_path, paragraph_pos, content_hash, source_uri, content, source, hash)
         VALUES ($1, 0, 'parent', gen_random_uuid(), 'c', 'd', 0, 'h', 'd', 'text', 'FPF', 'h')`, [runId]);
    const run = (id: string, doc: string, status: string, ageHours: number) =>
      q(`INSERT INTO full_ingest_runs (run_id, source, document_path, source_revision, total_chunks, status, created_at)
         VALUES ($1, 'FPF', $2, 'sha', 10, $3, now() - make_interval(hours => $4::int))`, [id, doc, status, ageHours]);
    await run(ids[0], "a.md", "abandoned", 1);
    await run(ids[1], "b.md", "running", 5);
    await run(ids[2], "c.md", "running", 0);
    for (const id of ids) await stage(id);
    await abandonStaleFullIngestRuns(makeEnv());
    const status = Object.fromEntries((await q(`SELECT document_path, status FROM full_ingest_runs`)).map((r) => [r.document_path, r.status]));
    expect(status).toEqual({ "a.md": "abandoned", "b.md": "abandoned", "c.md": "running" });
    expect(await stagingCount(ids[0])).toBe(0);
    expect(await stagingCount(ids[1])).toBe(0);
    expect(await stagingCount(ids[2])).toBe(1);
  });

  it("skips an unchanged document, but rebuilds it when the live copy is no longer the one we installed", async () => {
    const queue = makeQueue();
    const env = makeEnv({ FULL_INGEST_QUEUE: queue });
    const doc = { sha: "sha-7", text: syntheticDoc(15) };
    const { runId } = await startRun(env, doc);
    for (const body of queue.sent) await deliver(env, [body]);
    expect(await runStatus(runId)).toBe("swapped");

    const net = stubNetwork(doc);
    const same = await postFullIngest(env, { source: SOURCE, path: DOC, dry_run: false });
    expect(same.json.results[0].outcome).toBe("unchanged");
    expect(net.blobFetches).toBe(0);

    // The manual loader replaces the document: same blob SHA upstream, different live rows.
    await q(`DELETE FROM knowledge_chunk WHERE source = $1 AND account_id IS NULL`, [SOURCE]);
    await q(`INSERT INTO knowledge_chunk (chunk_id, document_path, paragraph_pos, content_hash, source_uri, content, source, source_kind, hash, collection_kind)
             VALUES ($1, $2, 0, 'h', $2, 'loader copy', $3, 'pack', 'h', 'platform')`, [`${DOC}::p0`, DOC, SOURCE]);
    const rebuilt = await postFullIngest(env, { source: SOURCE, path: DOC, dry_run: false });
    expect(rebuilt.json.results[0].outcome).toBe("queued");

    // A new upstream revision is also rebuilt (the previous run is closed first).
    await q(`UPDATE full_ingest_runs SET status = 'abandoned' WHERE status = 'running'`);
    stubNetwork({ sha: "sha-8", text: syntheticDoc(15) });
    const next = await postFullIngest(env, { source: SOURCE, path: DOC, dry_run: false });
    expect(next.json.results[0].outcome).toBe("queued");
  });

  it("never publishes a run that was abandoned in the middle of staging", async () => {
    const queue = makeQueue();
    const env = makeEnv({ FULL_INGEST_QUEUE: queue });
    stubNetwork({ sha: "sha-14", text: syntheticDoc(260) });
    // The sweep (or an operator) abandons the run right after the first staging transaction.
    // Later inserts are conditional on status = 'running', so they silently write nothing.
    let transactions = 0;
    pgAdapter.holder.afterTransaction = async () => {
      transactions++;
      if (transactions === 1) await q(`UPDATE full_ingest_runs SET status = 'abandoned' WHERE status = 'running'`);
    };
    const res = await postFullIngest(env, { source: SOURCE, path: DOC, dry_run: false });
    expect(res.json.results[0].outcome).toBe("failed");
    expect(res.json.results[0].detail).toContain("staging incomplete");
    expect(queue.sent.length).toBe(0);
    expect(await stagingCount()).toBe(0);
  });

  it("does not start a second run while one is in flight", async () => {
    const env = makeEnv({ FULL_INGEST_QUEUE: makeQueue() });
    await startRun(env, { sha: "sha-9", text: syntheticDoc(15) });
    const again = await postFullIngest(env, { source: SOURCE, path: DOC, dry_run: false });
    expect(again.json.results[0].outcome).toBe("in_progress");
    expect((await q(`SELECT count(*)::int AS n FROM full_ingest_runs`))[0].n).toBe(1);
  });

  it("the kill switch stops new runs and writes nothing", async () => {
    const queue = makeQueue();
    const env = makeEnv({ FULL_INGEST_QUEUE: queue, FULL_INGEST_DISABLED: "true" });
    stubNetwork({ sha: "sha-10", text: syntheticDoc(15) });
    const res = await postFullIngest(env, { source: SOURCE, path: DOC, dry_run: false });
    expect(res.json.results[0].outcome).toBe("disabled");
    expect((await q(`SELECT count(*)::int AS n FROM full_ingest_runs`))[0].n).toBe(0);
    expect(queue.calls).toBe(0);
  });

  it("defaults to a dry run that reports the plan and writes nothing, even before the queue exists", async () => {
    const env = makeEnv(); // no FULL_INGEST_QUEUE bound
    stubNetwork({ sha: "sha-11", text: syntheticDoc(45) });
    const res = await postFullIngest(env, { source: SOURCE });
    expect(res.status).toBe(200);
    expect(res.json.dry_run).toBe(true);
    expect(res.json.results).toEqual([{ path: DOC, outcome: "dry_run", total_chunks: 47, messages: 5, source_revision: "sha-11" }]);
    expect((await q(`SELECT count(*)::int AS n FROM full_ingest_runs`))[0].n).toBe(0);
    expect(await stagingCount()).toBe(0);
  });

  it("reports queue_unbound for a real run until the queue is bound", async () => {
    stubNetwork({ sha: "sha-12", text: syntheticDoc(15) });
    const res = await postFullIngest(makeEnv(), { source: SOURCE, path: DOC, dry_run: false });
    expect(res.json.results[0].outcome).toBe("queue_unbound");
    expect((await q(`SELECT count(*)::int AS n FROM full_ingest_runs`))[0].n).toBe(0);
  });

  it("gives repeated section titles distinct source_uri (#2, #3) so the swap cannot trip the unique index", async () => {
    const queue = makeQueue();
    const env = makeEnv({ FULL_INGEST_QUEUE: queue });
    const titleOf = (i: number) => (i % 3 === 0 ? "Sources" : `Section ${i}`);
    await startRun(env, { sha: "sha-13", text: syntheticDoc(12, titleOf) });
    for (const body of queue.sent) await deliver(env, [body]);
    const uris = (await liveDoc()).map((r) => r.source_uri);
    expect(uris).toContain(`${DOC}::Sources`);
    expect(uris).toContain(`${DOC}::Sources#2`);
    expect(uris).toContain(`${DOC}::Sources#4`);
    expect(new Set(uris).size).toBe(uris.length);
  });

  it("guards the manual entry point: secret required, personal mode refused, only known sources", async () => {
    const env = makeEnv();
    expect((await postFullIngest(env, { source: SOURCE }, null)).status).toBe(401);
    expect((await postFullIngest(env, { source: SOURCE }, "wrong")).status).toBe(401);
    expect((await postFullIngest(makeEnv({ MCP_MODE: "private" }), { source: SOURCE })).status).toBe(503);
    expect((await postFullIngest(makeEnv({ REINDEX_SECRET: undefined }), { source: SOURCE })).status).toBe(503);
    const unknown = await postFullIngest(env, { source: "PACK-secret" });
    expect(unknown.status).toBe(400);
    expect(unknown.json.reason).toBe("source_not_in_full_ingest_sources");
  });

  it.skipIf(!REAL_DOC)("runs the whole pipeline on the real FPF-Spec.md", async () => {
    const text = readFileSync(REAL_DOC!, "utf8");
    const queue = makeQueue();
    const env = makeEnv({ FULL_INGEST_QUEUE: queue });
    await seedOldEdition();
    const t0 = Date.now();
    const { runId, totalChunks } = await startRun(env, { sha: "real-sha", text });
    const producedMs = Date.now() - t0;
    expect(totalChunks).toBeGreaterThan(1000);
    expect(queue.sent.length).toBe(Math.ceil((totalChunks - 1) / 10));
    expect(await stagingCount(runId)).toBe(totalChunks);
    const t1 = Date.now();
    for (const body of queue.sent) await deliver(env, [body]);
    const consumedMs = Date.now() - t1;
    expect(await runStatus(runId)).toBe("swapped");
    const live = await liveDoc();
    expect(live.length).toBe(totalChunks);
    expect((await q(`SELECT length(search_vector) AS lexemes FROM knowledge_chunk WHERE chunk_uuid = $1`, [runId]))[0].lexemes).toBeGreaterThan(1000);
    expect(live.some((r) => String(r.content).startsWith("OLD"))).toBe(false);
    console.info(JSON.stringify({ real_doc: true, chunks: totalChunks, messages: queue.sent.length, produced_ms: producedMs, consumed_ms: consumedMs }));
  }, 900_000);
});
