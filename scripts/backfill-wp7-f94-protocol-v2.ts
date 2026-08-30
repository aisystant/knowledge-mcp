#!/usr/bin/env npx tsx
/**
 * WP-7 Ф94 backfill driver: enqueue a reindex for every (user_id, source) pair
 * still on protocol_version=1 (legacy chunking, truncated by the old LIMIT-1 read).
 *
 * Reads the live knowledge.documents table directly (read-only) to build the
 * work list, then drives the already-deployed /reindex-full endpoint per pair
 * with the service-secret auth path (same one webhook.ts/oauth.ts already use
 * for single-user triggers) — this script is the first thing that loops it.
 *
 * Each call only enqueues a queue message (REINDEX_QUEUE); it does not wait
 * for the reindex itself to finish. Progress after enqueueing is visible via
 * the existing reindex_jobs table / personal_reindex_status tool.
 *
 * Usage:
 *   npx tsx scripts/backfill-wp7-f94-protocol-v2.ts                 # dry-run, prints work list
 *   npx tsx scripts/backfill-wp7-f94-protocol-v2.ts --execute       # actually enqueue
 *   npx tsx scripts/backfill-wp7-f94-protocol-v2.ts --execute --limit 5   # smoke-test on 5 pairs first
 *
 * Required env (not read from any repo file — pass at invocation):
 *   DATABASE_URL             live persona/knowledge Neon connection string
 *   INTERNAL_SERVICE_SECRET  Cloudflare Worker service-to-service secret
 * Optional:
 *   BASE_URL       default https://personal-knowledge-mcp.aisystant.workers.dev
 *   KNOWLEDGE_DB_SCHEMA  default "knowledge"
 */

import { neon } from "@neondatabase/serverless";

const DELAY_MS = 300; // pacing between /reindex-full calls — GitHub App installation
                       // tokens share a 5000 req/hr rate limit across all of a user's
                       // calls, and this endpoint has no retry/backoff around GitHub
                       // fetches (only around embeddings), so we throttle client-side.
const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const limitArg = args.find(a => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : undefined;

  const dbUrl = process.env.DATABASE_URL;
  const serviceSecret = process.env.INTERNAL_SERVICE_SECRET;
  const baseUrl = process.env.BASE_URL ?? "https://personal-knowledge-mcp.aisystant.workers.dev";
  const schema = process.env.KNOWLEDGE_DB_SCHEMA ?? "knowledge";

  if (!dbUrl) {
    console.error("DATABASE_URL is required (live persona/knowledge Neon connection string)");
    process.exit(1);
  }
  if (execute && !serviceSecret) {
    console.error("INTERNAL_SERVICE_SECRET is required for --execute (dry-run doesn't need it)");
    process.exit(1);
  }

  const sql = neon(dbUrl);
  const documentsTable = `${schema}.documents`;

  const pairs = (await sql`
    SELECT DISTINCT user_id, source
    FROM ${sql.unsafe(documentsTable)}
    WHERE protocol_version = 1
    ORDER BY user_id, source
  `) as { user_id: string; source: string }[];

  const workList = limit ? pairs.slice(0, limit) : pairs;
  console.log(`Work list: ${workList.length} (user_id, source) pairs still on protocol_version=1` +
    (limit ? ` (limited from ${pairs.length})` : ""));

  if (!execute) {
    for (const { user_id, source } of workList) {
      console.log(`[dry-run] would enqueue: user=${user_id} source=${source}`);
    }
    console.log("Dry-run only — pass --execute to actually enqueue reindex jobs.");
    return;
  }

  const results = { enqueued: 0, cooldown: 0, failed: 0 };
  for (const { user_id, source } of workList) {
    let lastError = "";
    let ok = false;
    for (let attempt = 1; attempt <= MAX_RETRIES && !ok; attempt++) {
      try {
        const res = await fetch(`${baseUrl}/reindex-full`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${serviceSecret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ user_id, source }),
        });
        const body = (await res.json()) as { status?: string; message?: string; error?: string };
        if (!res.ok) {
          lastError = `HTTP ${res.status}: ${body.error ?? body.message ?? "unknown"}`;
          if (res.status >= 500 || res.status === 429) {
            await sleep(DELAY_MS * attempt); // backoff, then retry
            continue;
          }
          break; // 4xx other than 429 won't succeed on retry
        }
        ok = true;
        if (body.status === "cooldown") {
          results.cooldown++;
          console.log(`cooldown: user=${user_id} source=${source} — ${body.message}`);
        } else {
          results.enqueued++;
          console.log(`enqueued: user=${user_id} source=${source} — job ${body.status}`);
        }
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        await sleep(DELAY_MS * attempt);
      }
    }
    if (!ok) {
      results.failed++;
      console.error(`FAILED: user=${user_id} source=${source} — ${lastError}`);
    }
    await sleep(DELAY_MS);
  }

  console.log(`\nDone. enqueued=${results.enqueued} cooldown=${results.cooldown} failed=${results.failed}`);
  if (results.failed > 0) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
