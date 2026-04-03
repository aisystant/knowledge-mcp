#!/usr/bin/env npx tsx
/**
 * Run migration 003: Retrieval Feedback (WP-184 Ф3)
 * Usage: npx tsx scripts/migrate-003.ts
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

  console.log("Running migration 003: Retrieval Feedback...");

  await sql`
    CREATE TABLE IF NOT EXISTS retrieval_feedback (
      id BIGSERIAL PRIMARY KEY,
      document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      query_hash VARCHAR(64) NOT NULL,
      helpfulness BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  console.log("  Created retrieval_feedback table");

  await sql`CREATE INDEX IF NOT EXISTS idx_feedback_document ON retrieval_feedback(document_id)`;
  console.log("  Created idx_feedback_document index");

  await sql`CREATE INDEX IF NOT EXISTS idx_feedback_created ON retrieval_feedback(created_at)`;
  console.log("  Created idx_feedback_created index");

  console.log("Migration 003 complete.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
