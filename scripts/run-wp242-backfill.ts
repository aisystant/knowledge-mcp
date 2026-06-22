#!/usr/bin/env npx tsx
/**
 * Run WP-242 Ф-B backfill (Python) with KNOWLEDGE_DATABASE_URL from .dev.vars
 * One-shot script, not meant for production use.
 * Usage: npx tsx scripts/run-wp242-backfill.ts [--dry-run] [--target u-star top50]
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

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

const backfillScript = join(
  __dirname,
  "../../../DS-my-strategy/inbox/WP-242/phase-b-backfill.py"
);

const args = process.argv.slice(2); // forward --dry-run, --target, etc.

const result = spawnSync(
  "python3",
  [backfillScript, "--db-url", dbUrl, ...args],
  {
    stdio: "inherit",
    env: { ...process.env, KNOWLEDGE_DATABASE_URL: dbUrl },
  }
);

process.exit(result.status ?? 1);
