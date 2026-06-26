#!/usr/bin/env npx tsx
/**
 * Apply migration 019 via psql.
 *
 * 019 uses DO $$ ... $$ blocks and dollar-quoted COMMENT strings; psql parses
 * these natively. The tagged-template / semicolon-splitter path would shred the
 * DO-block and cut COMMENT literals mid-quote.
 *
 * ON_ERROR_STOP=1 makes any constraint/view failure abort with non-zero exit.
 *
 * URL from .dev.vars (KNOWLEDGE_DATABASE_URL / DATABASE_URL), unpooled endpoint.
 *
 * Usage:
 *   npx tsx scripts/migrate-019.ts [--dry-run] [--file=migrations/other.sql]
 *
 * --file overrides the default migration path. Parameterized for forward
 * compatibility: next migrations can adopt a shared migrate.ts runner or keep
 * their own scripts. Peer-session 2026-06-26-15.
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

const fileArg = process.argv.find((a) => a.startsWith("--file="))?.split("=")[1];
const migration = fileArg
  ? join(process.cwd(), fileArg)
  : join(__dirname, "../migrations/019-concept-translatable-baseline.sql");

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
