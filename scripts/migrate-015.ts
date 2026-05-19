#!/usr/bin/env npx tsx
/**
 * Apply migration 015 (graph_freshness_events) to the health Neon DB.
 * WP-339 Ф6.
 *
 * Requires HEALTH_DATABASE_URL — set via wrangler secret in prod.
 * For local run: HEALTH_DATABASE_URL=<url> npx tsx scripts/migrate-015.ts
 */

import { neon } from "@neondatabase/serverless";

const rawUrl = process.env.HEALTH_DATABASE_URL;
if (!rawUrl) {
  console.error("HEALTH_DATABASE_URL env var required.");
  console.error("Usage: HEALTH_DATABASE_URL=<url> npx tsx scripts/migrate-015.ts");
  process.exit(1);
}

const sql = neon(rawUrl.replace("-pooler", ""));

console.log("=== Migration 015: graph_freshness_events ===\n");

console.log("1. health schema...");
await sql`CREATE SCHEMA IF NOT EXISTS health`;
console.log("  ✅");

console.log("2. health.graph_freshness_events table...");
await sql`
  CREATE TABLE IF NOT EXISTS health.graph_freshness_events (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source TEXT NOT NULL,
    github_count INT NOT NULL,
    db_count INT NOT NULL,
    drift INT NOT NULL GENERATED ALWAYS AS (github_count - db_count) STORED,
    reindexed BOOLEAN NOT NULL DEFAULT FALSE,
    reindex_processed INT,
    reindex_skipped INT,
    p99_staleness_hours REAL,
    error TEXT
  )
`;
console.log("  ✅");

console.log("3. Indexes...");
await sql`
  CREATE INDEX IF NOT EXISTS idx_freshness_source_created
    ON health.graph_freshness_events (source, created_at DESC)
`;
await sql`
  CREATE INDEX IF NOT EXISTS idx_freshness_created
    ON health.graph_freshness_events (created_at DESC)
`;
await sql`
  CREATE INDEX IF NOT EXISTS idx_freshness_drift
    ON health.graph_freshness_events (drift, created_at DESC)
    WHERE ABS(drift) > 5
`;
console.log("  ✅");

console.log("\n✅ Migration 015 applied.");
