#!/usr/bin/env npx tsx
/**
 * Run migration 002: Parent Retrieval
 * Usage: npx tsx scripts/migrate-002.ts
 */

import { neon } from "@neondatabase/serverless";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  const env: Record<string, string> = {};
  const devVarsPath = join(__dirname, "../.dev.vars");
  if (existsSync(devVarsPath)) {
    const vars = readFileSync(devVarsPath, "utf-8");
    for (const line of vars.split("\n")) {
      const match = line.match(/^(\w+)\s*=\s*(.+)$/);
      if (match) env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }

  const dbUrl = env.DATABASE_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("Missing DATABASE_URL");
    process.exit(1);
  }

  const sql = neon(dbUrl);

  console.log("Running migration 002: Parent Retrieval...");

  await sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES documents(id) ON DELETE SET NULL`;
  console.log("  Added parent_id column");

  await sql`CREATE INDEX IF NOT EXISTS idx_documents_parent_id ON documents(parent_id)`;
  console.log("  Created idx_documents_parent_id index");

  console.log("Migration 002 complete.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
