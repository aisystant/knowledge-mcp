#!/usr/bin/env npx tsx
// One-shot diagnostic for WP-242 Ф-B backfill — check what 22 concepts actually have.

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

// 1. Check the 22 concepts needing backfill
const rows = await sql`
WITH edge_counts AS (
    SELECT from_concept_id AS concept_id, COUNT(*) AS edge_count
    FROM concept_graph.concept_edges
    GROUP BY from_concept_id
),
ranked AS (
    SELECT c.id,
           ROW_NUMBER() OVER (PARTITION BY c.level ORDER BY COALESCE(ec.edge_count, 0) DESC) AS rank
    FROM concept_graph.concepts c
    LEFT JOIN edge_counts ec ON ec.concept_id = c.id
    WHERE c.status = 'active' AND c.level = 'pack' AND c.node_type = 'concept'
)
SELECT c.code, c.name, c.name_ru, c.name_en, c.level, c.source_doc, c.source_repo
FROM concept_graph.concepts c
LEFT JOIN ranked ON ranked.id = c.id
WHERE c.status = 'active'
  AND c.node_type = 'concept'
  AND (
      (c.level = 'fpf' AND c.code LIKE 'U.%')
      OR (c.level = 'pack' AND ranked.rank <= 50)
  )
  AND (c.name_ru IS NULL OR c.name_en IS NULL)
ORDER BY c.level, c.code
`;

console.log(`\nTotal concepts needing backfill: ${rows.length}`);
console.log("\nSample (first 10):");
for (const r of rows.slice(0, 10)) {
  console.log(
    `  [${r.level}] ${r.code} | name="${r.name?.slice(0,40)}" | name_ru=${r.name_ru ?? "NULL"} | name_en=${r.name_en ?? "NULL"}`
  );
}

// 2. Breakdown by what's missing
const bothNull = rows.filter(r => !r.name_ru && !r.name_en);
const onlyRuNull = rows.filter(r => !r.name_ru && r.name_en);
const onlyEnNull = rows.filter(r => r.name_ru && !r.name_en);
const nameIsRu = rows.filter(r => !r.name_ru && r.name && /[а-яА-ЯёЁ]/.test(r.name));

console.log(`\nBreakdown:`);
console.log(`  both null (nothing in DB): ${bothNull.length}`);
console.log(`  only name_ru null (en exists): ${onlyRuNull.length}`);
console.log(`  only name_en null (ru exists): ${onlyEnNull.length}`);
console.log(`  name field has Russian text (can auto-set name_ru): ${nameIsRu.length}`);

// 3. Glossary export view stats
const viewStats = await sql`
  SELECT COUNT(*) AS n, COUNT(DISTINCT domain) AS domains
  FROM concept_graph.concept_glossary_export
`;
console.log(`\nGlossary export view: ${viewStats[0].n} rows, ${viewStats[0].domains} domains`);
