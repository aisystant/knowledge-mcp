#!/usr/bin/env npx tsx
/**
 * Apply migrations 009 (reindex_jobs) + 010 (heartbeat cols) to Neon knowledge DB.
 * WP-339 Ф5 prerequisite.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { neon } from "@neondatabase/serverless";

const __dirname = dirname(fileURLToPath(import.meta.url));

const devVars = readFileSync(join(__dirname, "../.dev.vars"), "utf-8");
const urlMatch = devVars.match(/KNOWLEDGE_DATABASE_URL=(.+)/) ?? devVars.match(/DATABASE_URL=(.+)/);
if (!urlMatch) throw new Error("KNOWLEDGE_DATABASE_URL / DATABASE_URL not found in .dev.vars");

const sql = neon(urlMatch[1].trim().replace("-pooler", ""));

console.log("=== Migration 009: reindex_jobs ===\n");

console.log("1. pgcrypto extension...");
await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
console.log("  ✅");

console.log("2. public.reindex_jobs table...");
await sql`
  CREATE TABLE IF NOT EXISTS public.reindex_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
    processed INT NOT NULL DEFAULT 0,
    skipped INT NOT NULL DEFAULT 0,
    deleted INT NOT NULL DEFAULT 0,
    total INT,
    errors JSONB NOT NULL DEFAULT '[]'::jsonb,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
  )
`;
console.log("  ✅");

console.log("3. Index on reindex_jobs...");
await sql`
  CREATE INDEX IF NOT EXISTS idx_reindex_jobs_user_source_started
    ON public.reindex_jobs (user_id, source, started_at DESC)
`;
console.log("  ✅");

console.log("4. user_sources.auto_reindex_enabled column...");
await sql`
  ALTER TABLE public.user_sources
    ADD COLUMN IF NOT EXISTS auto_reindex_enabled BOOLEAN NOT NULL DEFAULT true
`;
console.log("  ✅");

console.log("\n=== Migration 010: heartbeat cols ===\n");

console.log("5. last_heartbeat_at column...");
await sql`ALTER TABLE public.reindex_jobs ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ`;
console.log("  ✅");

console.log("6. expected_batches column...");
await sql`ALTER TABLE public.reindex_jobs ADD COLUMN IF NOT EXISTS expected_batches INT`;
console.log("  ✅");

console.log("7. completed_batches column...");
await sql`ALTER TABLE public.reindex_jobs ADD COLUMN IF NOT EXISTS completed_batches INT NOT NULL DEFAULT 0`;
console.log("  ✅");

console.log("8. Watchdog index...");
await sql`
  CREATE INDEX IF NOT EXISTS idx_reindex_jobs_running_heartbeat
    ON public.reindex_jobs (last_heartbeat_at)
    WHERE status = 'running'
`;
console.log("  ✅");

console.log("\n✅ Migrations 009 + 010 applied.");
