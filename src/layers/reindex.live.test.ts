// Live opt-in integration test against the real Neon `persona` DB (WP-7 Ф97.2
// remainder, peer-session 2026-08-30-22-wp7-f97-2-remainder). Validates the
// scenario Codex identified in that session as the realistic tier-2 case: a
// write COMMITS to the database, but the caller never learns the outcome
// (network blip, worker eviction) — the webhook retry (Ф97.3) calls
// personalReindexFiles again with identical input. This must be idempotent:
// one status row, unchanged hash, no duplicate document chunks.
//
// NOT covered (documented gap, not this test's job): gateway/webhook HTTP
// transport failures, and concurrent interleaving of two DIFFERENT pushes for
// the same file — see the race-condition comment on buildIndexStatusSuccessQuery
// in personal.ts. That requires an ordered revision/idempotency key, deferred
// as separate work (peer-session 2026-08-30-22 consensus).
//
// Opt-in only — `describe.skipIf` below means the suite body (and every real
// network/DB call in it) only runs with both env vars set; regular
// `npm test`/CI evaluates the skipped shell but never executes it:
//   RUN_LIVE_NEON_TESTS=1 LIVE_NEON_DATABASE_URL=postgres://... \
//     npx vitest run src/layers/reindex.live.test.ts
//
// Do NOT point LIVE_NEON_DATABASE_URL at this repo's own .dev.vars
// DATABASE_URL — that file connects to an unrelated Neon database that
// happens to share the "knowledge" schema name by coincidence (found live
// during the migration-021 rollout, 2026-08-30). The real database backing
// personalReindexFiles in production is the "persona" database in the
// "aisystant" Neon project, schema "knowledge" — pass ITS connection string
// explicitly via LIVE_NEON_DATABASE_URL.
//
// GitHub content and OpenRouter embeddings are mocked (fetch) — this test
// exercises the DB transaction/idempotency path, not network reachability.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getKnowledgeSchema, KNOWLEDGE_TABLES } from "../utils/db.js";
import { personalDb } from "./personal.js";

vi.mock("./personal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./personal.js")>();
  return {
    ...actual,
    // Real DB calls (personalDb, resolveUserContext, the status-query
    // builders) stay real — only GitHub App auth is faked, since this test
    // never needs a real installation token.
    getInstallationToken: vi.fn(async () => "fake-live-test-installation-token"),
  };
});

const RUN_LIVE = process.env.RUN_LIVE_NEON_TESTS === "1";
const DB_URL = process.env.LIVE_NEON_DATABASE_URL;

describe.skipIf(!RUN_LIVE || !DB_URL)("personalReindexFiles — live Neon idempotency (opt-in)", () => {
  const TEST_SOURCE = `test-live-f972-${randomUUID().slice(0, 8)}`;
  const TEST_USER_ID = "test-live-f972-user";
  const TEST_PATH = "live-test-file.md";
  const TEST_CONTENT = "Live idempotency test content — WP-7 Ф97.2 remainder.";
  const FAKE_EMBEDDING = Array(1024).fill(0.01);

  const ENV = {
    DATABASE_URL: DB_URL as string,
    OPENROUTER_API_KEY: "fake-key-not-called-for-real",
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "fake-not-used",
  };

  // Reuses personalDb() itself (the same helper personalReindexFiles calls)
  // rather than calling neon() directly — ReturnType<typeof neon> on the
  // bare generic function doesn't narrow to concrete row types the way a
  // call through personalDb's own inferred return type does (found via CI
  // typecheck: indexing `existing[0]` etc. failed with the raw import).
  let sql: ReturnType<typeof personalDb>;
  let schema: string;
  let documentsTable: string;
  let statusTable: string;
  let userSourcesTable: string;

  beforeAll(async () => {
    sql = personalDb(ENV);
    schema = getKnowledgeSchema(ENV);
    documentsTable = KNOWLEDGE_TABLES.documents(schema);
    statusTable = KNOWLEDGE_TABLES.file_index_status(schema);
    userSourcesTable = KNOWLEDGE_TABLES.user_sources(schema);

    await sql`
      INSERT INTO ${sql.unsafe(userSourcesTable)}
        (user_id, source, github_owner, github_repo, path_prefix, source_type)
      VALUES (${TEST_USER_ID}, ${TEST_SOURCE}, 'test-owner', 'test-repo', '', 'ds')
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    // Independent try/catch per table: an earlier test-run's fetch-mock bug
    // (fixed in this file, see mockFetchOnce) once corrupted the DB driver's
    // own transport mid-test, which aborted this cleanup after its first
    // statement and left an orphaned user_sources row behind (found live,
    // cleaned up manually). Each DELETE now runs independently so a failure
    // in one never skips the others.
    for (const table of [statusTable, documentsTable, userSourcesTable]) {
      try {
        // Scoped by user_id AND source (not source alone) — defense in depth
        // matching file_index_status's own PK shape, even though TEST_SOURCE's
        // random suffix already makes a collision with real data implausible.
        await sql`DELETE FROM ${sql.unsafe(table)} WHERE user_id = ${TEST_USER_ID} AND source = ${TEST_SOURCE}`;
      } catch (err) {
        console.error(`[reindex.live.test] cleanup failed for ${table}:`, err instanceof Error ? err.message : err);
      }
    }
  });

  it("retry after a lost response is idempotent: one status row, one chunk set, unchanged hash", async () => {
    const { personalReindexFiles } = await import("./reindex.js");

    // The Neon serverless driver also calls global fetch (its HTTP transport) —
    // a blanket mock would break every real DB query personalReindexFiles makes
    // (resolveUserContext, hash lookup, the transaction itself). Intercept only
    // the two external URLs this test needs to fake; everything else (Neon's
    // endpoint) goes to the real fetch. Restored in `finally` — under current
    // Vitest defaults (isolate: true, forks-per-file) this can't leak into
    // other test files anyway, but a raw `globalThis.fetch =` assignment left
    // unrestored is one config change away from doing exactly that.
    const realFetch = globalThis.fetch;
    const mockFetchOnce = () => {
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith("https://api.github.com/")) {
          return { ok: true, text: async () => TEST_CONTENT } as Response;
        }
        if (url.startsWith("https://openrouter.ai/")) {
          return { ok: true, json: async () => ({ data: [{ embedding: FAKE_EMBEDDING }] }) } as Response;
        }
        return realFetch(input, init);
      }) as unknown as typeof fetch;
    };

    try {
      // First call: real write, commits to the real DB.
      mockFetchOnce();
      const first = await personalReindexFiles(ENV, {
        source: TEST_SOURCE, files: [{ path: TEST_PATH, action: "modified" }], user_id: TEST_USER_ID,
      });
      expect(first.processed).toBe(1);
      expect(first.errors).toEqual([]);

      const statusAfterFirst = await sql`
        SELECT status, content_hash, updated_at FROM ${sql.unsafe(statusTable)}
        WHERE user_id = ${TEST_USER_ID} AND source = ${TEST_SOURCE} AND filename = ${TEST_PATH}
      `;
      expect(statusAfterFirst).toHaveLength(1);
      expect(statusAfterFirst[0].status).toBe("indexed");

      const chunksAfterFirst = await sql`
        SELECT id FROM ${sql.unsafe(documentsTable)} WHERE source = ${TEST_SOURCE} AND filename = ${TEST_PATH}
      `;
      expect(chunksAfterFirst.length).toBeGreaterThan(0);
      const chunkCountAfterFirst = chunksAfterFirst.length;

      // Simulate the webhook retry (Ф97.3): the caller never learned that the
      // first call committed, and calls personalReindexFiles again with the
      // exact same input — same content, same hash.
      mockFetchOnce();
      const retry = await personalReindexFiles(ENV, {
        source: TEST_SOURCE, files: [{ path: TEST_PATH, action: "modified" }], user_id: TEST_USER_ID,
      });
      // Hash-match skip path (existing logic) — not reprocessed, but status
      // upsert still fires (WP-7 Ф97.2 round-1 consensus: skip must confirm
      // status too, or a retry after partial batch failure would leave this
      // file's status permanently unset).
      expect(retry.skipped).toBe(1);
      expect(retry.processed).toBe(0);
      expect(retry.errors).toEqual([]);

      const statusAfterRetry = await sql`
        SELECT status, content_hash FROM ${sql.unsafe(statusTable)}
        WHERE user_id = ${TEST_USER_ID} AND source = ${TEST_SOURCE} AND filename = ${TEST_PATH}
      `;
      // Idempotency: still exactly one row, same hash — no duplicate status rows.
      expect(statusAfterRetry).toHaveLength(1);
      expect(statusAfterRetry[0].status).toBe("indexed");
      expect(statusAfterRetry[0].content_hash).toBe(statusAfterFirst[0].content_hash);

      const chunksAfterRetry = await sql`
        SELECT id FROM ${sql.unsafe(documentsTable)} WHERE source = ${TEST_SOURCE} AND filename = ${TEST_PATH}
      `;
      // Idempotency: no duplicate chunks from the retry.
      expect(chunksAfterRetry.length).toBe(chunkCountAfterFirst);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
