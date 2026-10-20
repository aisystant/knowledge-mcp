#!/usr/bin/env npx tsx
/**
 * Backfill source_class/source_owner for existing knowledge_chunk rows (WP-596 Ф7,
 * zontik WP-542). Migration 031 adds the columns nullable, without touching old rows —
 * this script fills them from the current sources-*.json registry, once, after the
 * migration is applied. ingest.ts writes these columns for every new/changed row going
 * forward; this script only catches up rows that ingest.ts has no reason to re-touch
 * (unchanged content hash).
 *
 * Scoped UPDATE (not a bare WHERE source = ?): two sources can share a name across a
 * platform config and a different user's personal config, so the match also requires
 * account_id to agree with the registry entry's user_id — otherwise a personal row
 * could receive another source's class/owner by name collision alone.
 *
 * Usage:
 *   npx tsx scripts/backfill-source-class-owner.ts [--dry-run]
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { neon } from "@neondatabase/serverless";
import { validateSourceConfigs, type SourceConfig } from "./ingest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadDevVars(): Record<string, string> {
  const path = join(__dirname, "../.dev.vars");
  if (!existsSync(path)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

function loadRegistry(): SourceConfig[] {
  // sources.json (the legacy combined/full-reindex config used by reindex.sh and
  // `npm run ingest:all`) overlaps with sources-platform.json but is not identical —
  // it carries sources the split files don't (found by code review: PACK-agent-rules,
  // PACK-engineering-management, PACK-rhetoric, PACK-systems-art, and a platform-scope
  // copy of DS-Knowledge-Index-Tseren). Loading all three means a source listed in any
  // of them gets backfilled; overlapping entries are harmless here (idempotent UPDATE).
  const files = ["sources.json", "sources-platform.json", "sources-personal.json"];
  const registry: SourceConfig[] = [];
  for (const file of files) {
    const path = join(__dirname, file);
    if (!existsSync(path)) continue;
    registry.push(...(JSON.parse(readFileSync(path, "utf-8")) as SourceConfig[]));
  }
  return registry;
}

/** Same (source, user_id) pair must not appear twice with a different class/owner. */
function checkNoConflicts(registry: SourceConfig[]): void {
  const seen = new Map<string, SourceConfig>();
  const conflicts: string[] = [];
  for (const entry of registry) {
    const key = `${entry.source}::${entry.user_id ?? ""}`;
    const prior = seen.get(key);
    if (prior && (prior.source_class !== entry.source_class || prior.source_owner !== entry.source_owner)) {
      conflicts.push(
        `"${entry.source}" (user_id=${entry.user_id ?? "none"}): ${prior.source_class}/${prior.source_owner} vs ${entry.source_class}/${entry.source_owner}`
      );
    }
    seen.set(key, entry);
  }
  if (conflicts.length > 0) {
    throw new Error(`Конфликтующие записи реестра (${conflicts.length}):\n  - ${conflicts.join("\n  - ")}`);
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const vars = loadDevVars();
  const dbUrl = process.env.DATABASE_URL || vars.DATABASE_URL;
  if (!dbUrl) {
    console.error("Missing DATABASE_URL (env or .dev.vars)");
    process.exit(1);
  }

  const registry = loadRegistry();
  validateSourceConfigs(registry);
  checkNoConflicts(registry);
  console.log(`Registry: ${registry.length} known sources`);

  const sql = neon(dbUrl);

  const beforeNull = (await sql`
    SELECT count(*)::int AS n FROM public.knowledge_chunk WHERE source_class IS NULL
  `) as { n: number }[];
  console.log(`Rows with source_class IS NULL before backfill: ${beforeNull[0].n}`);

  let updated = 0;
  for (const entry of registry) {
    const accountId: string | null = entry.user_id ?? null;
    if (dryRun) {
      const toUpdate = (await sql`
        SELECT count(*)::int AS n FROM public.knowledge_chunk
        WHERE source = ${entry.source}
          AND account_id IS NOT DISTINCT FROM ${accountId}::uuid
          AND source_class IS NULL
      `) as { n: number }[];
      console.log(`  [dry-run] ${entry.source}: would update ${toUpdate[0].n} rows`);
      continue;
    }
    const result = (await sql`
      UPDATE public.knowledge_chunk
      SET source_class = ${entry.source_class}, source_owner = ${entry.source_owner}
      WHERE source = ${entry.source}
        AND account_id IS NOT DISTINCT FROM ${accountId}::uuid
        AND source_class IS NULL
      RETURNING chunk_uuid
    `) as unknown[];
    updated += result.length;
    console.log(`  ${entry.source}: updated ${result.length} rows`);
  }

  if (dryRun) {
    console.log("\n[dry-run] no rows were modified");
    return;
  }

  console.log(`\nBackfill done. Total rows updated: ${updated}`);

  const registrySources = new Set(registry.map((e) => e.source));
  const remaining = (await sql`
    SELECT source, count(*)::int AS n FROM public.knowledge_chunk
    WHERE source_class IS NULL
    GROUP BY source ORDER BY n DESC
  `) as { source: string; n: number }[];

  if (remaining.length === 0) {
    console.log("No remaining NULL rows.");
    return;
  }

  const outsideRegistry = remaining.filter((r) => !registrySources.has(r.source));
  const insideRegistry = remaining.filter((r) => registrySources.has(r.source));

  if (insideRegistry.length > 0) {
    console.error(
      `⚠️  ${insideRegistry.length} known source(s) still have NULL rows after backfill (unexpected — check account_id mismatch):`
    );
    for (const r of insideRegistry) console.error(`   ${r.source}: ${r.n} rows`);
  }
  if (outsideRegistry.length > 0) {
    console.log(`\nRows with source_class IS NULL that are NOT in the current registry (not backfilled, by design):`);
    for (const r of outsideRegistry) console.log(`   ${r.source}: ${r.n} rows`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
