#!/usr/bin/env npx tsx
/**
 * Apply migration 016: concept_glossary_export view (WP-242 Ф-C)
 * Usage: npx tsx scripts/migrate-016.ts
 * Reads KNOWLEDGE_DATABASE_URL (or DATABASE_URL fallback) from .dev.vars
 */

import { neon } from "@neondatabase/serverless";
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
const rawUrl =
  process.env.KNOWLEDGE_DATABASE_URL ??
  vars.KNOWLEDGE_DATABASE_URL ??
  process.env.DATABASE_URL ??
  vars.DATABASE_URL;

if (!rawUrl) {
  console.error("KNOWLEDGE_DATABASE_URL or DATABASE_URL required");
  process.exit(1);
}

const sql = neon(rawUrl.replace("-pooler", ""));

console.log("=== Migration 016: concept_glossary_export view (WP-242 Ф-C) ===\n");

console.log("1. Creating concept_glossary_export view...");
await sql`
  CREATE OR REPLACE VIEW concept_graph.concept_glossary_export AS
  SELECT
    code,
    name_ru,
    name_en,
    definition,
    domain,
    status
  FROM concept_graph.concepts
  WHERE status = 'active'
    AND level = 'pack'
    AND node_type = 'concept'
    AND name_ru IS NOT NULL
    AND name_en IS NOT NULL
  ORDER BY domain NULLS LAST, code
`;
console.log("  ✅ view created");

console.log("2. Adding comment...");
await sql`
  COMMENT ON VIEW concept_graph.concept_glossary_export IS
    'Bilingual pack terminology for translate.py (WP-415). Only active pack concepts with both name_ru and name_en. WP-242 owns the data; WP-415 owns the format contract.'
`;
console.log("  ✅ comment set");

console.log("3. Verifying row count...");
const rows = await sql`SELECT COUNT(*) AS n FROM concept_graph.concept_glossary_export`;
console.log(`  ✅ ${rows[0].n} bilingual pack concepts exported`);

console.log("\n=== Migration 016 complete ===");
