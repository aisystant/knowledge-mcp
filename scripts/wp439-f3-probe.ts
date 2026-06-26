#!/usr/bin/env npx tsx
/**
 * WP-439 Ф3 probe (READ-ONLY) — understand the 578 'unknown' name_en entries
 * before deciding reclassification vs re-translation.
 *
 * Answers:
 *  1. How many of the 578 have name_en NOT NULL (frontmatter hypothesis)?
 *  2. What is the created_at distribution (before/after migration 017 on 2026-06-25)?
 *  3. Sample of unknown entries to validate quality.
 *  4. Current sizes of concept_kind_context and concept_translation_orphans.
 *
 * No writes. Pattern mirrors wp439-apply-anchor.ts.
 *
 * Usage:
 *   npx tsx scripts/wp439-f3-probe.ts
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { neon } from "@neondatabase/serverless";

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
  vars.DATABASE_URL ??
  "";
if (!rawUrl) {
  console.error("KNOWLEDGE_DATABASE_URL or DATABASE_URL not found");
  process.exit(1);
}
const sql = neon(rawUrl.replace("-pooler", ""));

// --- 1. Distribution by (has_en, source, status) ---
const dist = await sql`
  SELECT
    name_en_source,
    name_en_status,
    (name_en IS NOT NULL) AS has_en,
    COUNT(*)::int AS n
  FROM concept_graph.concepts
  GROUP BY 1, 2, 3
  ORDER BY 4 DESC
`;
console.log("\n=== 1. name_en distribution (all concepts) ===");
for (const row of dist) {
  const enFlag = row.has_en ? "has_en" : "null_en";
  console.log(`  source=${row.name_en_source ?? "NULL"} status=${row.name_en_status ?? "NULL"} ${enFlag}: ${row.n}`);
}

// --- 2. 'unknown' breakdown: null vs not-null, and created_at range ---
const unknownBreakdown = await sql`
  SELECT
    (name_en IS NOT NULL) AS has_en,
    date_trunc('day', created_at)::date AS day,
    COUNT(*)::int AS n
  FROM concept_graph.concepts
  WHERE name_en_source = 'unknown'
  GROUP BY 1, 2
  ORDER BY 2 DESC, 1 DESC
`;
console.log("\n=== 2. 'unknown' source breakdown (created_at by day) ===");
for (const row of unknownBreakdown) {
  const enFlag = row.has_en ? "has_en" : "null_en";
  console.log(`  ${row.day} ${enFlag}: ${row.n}`);
}

// --- 3. Sample 10 unknown entries: code, name_ru, name_en, created_at ---
const sample = await sql`
  SELECT code, name_ru, name_en, name_en_status, created_at::date AS day
  FROM concept_graph.concepts
  WHERE name_en_source = 'unknown'
  ORDER BY random()
  LIMIT 10
`;
console.log("\n=== 3. Sample (10 random 'unknown') ===");
for (const row of sample) {
  console.log(`  ${row.code} | name_ru=${row.name_ru ?? "-"} | name_en=${row.name_en ?? "NULL"} | status=${row.name_en_status} | day=${row.day}`);
}

// --- 4. Orphan VIEWs sizes (from Ф2) ---
const viewSizes = await sql`
  SELECT
    (SELECT COUNT(*)::int FROM concept_graph.concept_kind_context) AS kind_context,
    (SELECT COUNT(*)::int FROM concept_graph.concept_translation_orphans) AS orphans
`;
console.log("\n=== 4. Ф2 VIEW sizes ===");
console.log(`  concept_kind_context:       ${viewSizes[0].kind_context}`);
console.log(`  concept_translation_orphans: ${viewSizes[0].orphans}`);

// --- 5. Sanity check: orphans (name_en IS NULL) should not overlap with unknown (has name_en) ---
// concept_translation_orphans.id = concepts.id (VIEW column, not concept_id)
const overlap = await sql`
  SELECT COUNT(*)::int AS n
  FROM concept_graph.concept_translation_orphans o
  JOIN concept_graph.concepts c ON c.id = o.id
  WHERE c.name_en_source = 'unknown'
`;
console.log(`\n  unknown concepts appearing in translation_orphans: ${overlap[0].n}`);
console.log("  (should be 0 — orphans = name_en IS NULL; unknown = has name_en with unknown source)\n");
