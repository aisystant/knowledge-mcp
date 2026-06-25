#!/usr/bin/env npx tsx
/**
 * Apply migration 018 via psql.
 *
 * 018 uses a `DO $$ ... $$` block + dollar-quoted COMMENT strings. The tagged-
 * template / `;`-splitter path (wp439-apply-anchor.ts:migrationStatements) would
 * shred the DO-block and cut COMMENT literals mid-quote. psql parses this idiom
 * natively, so 018 is applied with `psql -f` (same idiom as package.json `schema`).
 *
 * ON_ERROR_STOP=1 makes the DO-block guard (RAISE EXCEPTION on any inherited rows)
 * and any constraint/view failure abort with a non-zero exit.
 *
 * URL from .dev.vars (KNOWLEDGE_DATABASE_URL / DATABASE_URL), unpooled endpoint.
 * Usage: npx tsx scripts/migrate-018.ts [--dry-run]
 */

import { spawnSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

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

const vars = loadDevVars();
const dbUrl =
  process.env.KNOWLEDGE_DATABASE_URL ??
  vars.KNOWLEDGE_DATABASE_URL ??
  process.env.DATABASE_URL ??
  vars.DATABASE_URL;
if (!dbUrl) {
  console.error("KNOWLEDGE_DATABASE_URL or DATABASE_URL not found");
  process.exit(1);
}

const migration = join(__dirname, "../migrations/018-concept-kind-context.sql");
if (!existsSync(migration)) {
  console.error(`migration not found: ${migration}`);
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");
if (dryRun) {
  console.log(`[dry-run] would apply via psql -f ${migration}`);
  process.exit(0);
}

const r = spawnSync(
  "psql",
  [dbUrl.replace("-pooler", ""), "-v", "ON_ERROR_STOP=1", "-f", migration],
  { stdio: "inherit" }
);
if (r.error) {
  console.error("psql failed to launch (is it installed?):", r.error.message);
  process.exit(1);
}
process.exit(r.status ?? 1);
