#!/usr/bin/env npx tsx
// One-shot: copy `name` → `name_ru` for pack concepts where name is Russian and name_ru is null.
// WP-242 Ф-B prerequisite before file backfill.

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
const rawUrl = vars.KNOWLEDGE_DATABASE_URL ?? vars.DATABASE_URL ?? "";
const sql = neon(rawUrl.replace("-pooler", ""));

const dryRun = process.argv.includes("--dry-run");

// Find top-50 pack concepts where name has Cyrillic and name_ru is null
const candidates = await sql`
WITH edge_counts AS (
    SELECT from_concept_id AS concept_id, COUNT(*) AS edge_count
    FROM concept_graph.concept_edges
    GROUP BY from_concept_id
),
ranked AS (
    SELECT c.id, ROW_NUMBER() OVER (
        PARTITION BY c.level ORDER BY COALESCE(ec.edge_count, 0) DESC
    ) AS rank
    FROM concept_graph.concepts c
    LEFT JOIN edge_counts ec ON ec.concept_id = c.id
    WHERE c.status = 'active' AND c.level = 'pack' AND c.node_type = 'concept'
)
SELECT c.id, c.code, c.name
FROM concept_graph.concepts c
LEFT JOIN ranked ON ranked.id = c.id
WHERE c.status = 'active'
  AND c.node_type = 'concept'
  AND c.level = 'pack'
  AND ranked.rank <= 50
  AND c.name_ru IS NULL
  AND c.name ~ '[а-яА-ЯёЁ]'
ORDER BY c.code
`;

console.log(`Found ${candidates.length} concepts with Russian name and null name_ru`);
for (const r of candidates) {
  console.log(`  ${r.code}: "${r.name?.slice(0, 60)}"`);
}

if (dryRun) {
  console.log("\n[dry-run] no changes written");
  process.exit(0);
}

if (candidates.length === 0) {
  console.log("Nothing to update.");
  process.exit(0);
}

const ids = candidates.map(r => r.id);
const result = await sql`
  UPDATE concept_graph.concepts
  SET name_ru = name
  WHERE id = ANY(${ids}::bigint[])
    AND name_ru IS NULL
`;

console.log(`\nUpdated ${candidates.length} concepts: name → name_ru`);
