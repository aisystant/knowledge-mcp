#!/usr/bin/env npx tsx
// WP-242 Ф-D: program coverage gap query against concept graph.
// Finds concepts in WP-364 program scope that are not yet in the graph.

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

console.log("=== WP-242 Ф-D: Program Coverage Gap Query ===\n");

// 1. Overall graph stats
const stats = await sql`
  SELECT
    COUNT(*) FILTER (WHERE node_type = 'concept' AND status = 'active') AS active_concepts,
    COUNT(*) FILTER (WHERE level = 'fpf' AND status = 'active') AS fpf_concepts,
    COUNT(*) FILTER (WHERE level = 'pack' AND status = 'active') AS pack_concepts,
    COUNT(*) FILTER (WHERE status = 'active' AND name_ru IS NOT NULL AND name_en IS NOT NULL) AS bilingual,
    COUNT(*) FILTER (WHERE status = 'active' AND name_ru IS NOT NULL AND name_en IS NULL) AS ru_only,
    COUNT(*) FILTER (WHERE status = 'active' AND name_ru IS NULL) AS missing_ru
  FROM concept_graph.concepts
`;
const s = stats[0];
console.log("Graph health:");
console.log(`  Total active concepts: ${s.active_concepts} (FPF: ${s.fpf_concepts}, Pack: ${s.pack_concepts})`);
console.log(`  Bilingual (both fields): ${s.bilingual}`);
console.log(`  RU only (missing EN):   ${s.ru_only}`);
console.log(`  Missing RU:             ${s.missing_ru}`);

// 2. Domain coverage — which domains are well-represented
const domainCoverage = await sql`
  SELECT
    COALESCE(domain, 'unset') AS domain,
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE name_ru IS NOT NULL AND name_en IS NOT NULL) AS bilingual,
    ROUND(100.0 * COUNT(*) FILTER (WHERE name_ru IS NOT NULL AND name_en IS NOT NULL) / COUNT(*)) AS coverage_pct
  FROM concept_graph.concepts
  WHERE status = 'active' AND level = 'pack' AND node_type = 'concept'
  GROUP BY domain
  ORDER BY total DESC
`;

console.log("\nDomain coverage (pack concepts only):");
for (const row of domainCoverage) {
  const bar = "█".repeat(Math.floor(Number(row.coverage_pct) / 10));
  console.log(`  ${String(row.domain).padEnd(30)} ${bar.padEnd(10)} ${row.coverage_pct}% (${row.bilingual}/${row.total})`);
}

// 3. Orphan check — concepts with no edges
const orphans = await sql`
  SELECT c.code, c.name, c.level
  FROM concept_graph.concepts c
  LEFT JOIN concept_graph.concept_edges e1 ON e1.from_concept_id = c.id
  LEFT JOIN concept_graph.concept_edges e2 ON e2.to_concept_id = c.id
  WHERE c.status = 'active'
    AND c.level = 'fpf'
    AND e1.id IS NULL
    AND e2.id IS NULL
  ORDER BY c.code
`;
console.log(`\nFPF orphans (no edges, category 1): ${orphans.length}`);
for (const r of orphans) {
  console.log(`  ${r.code}: ${r.name?.slice(0, 60)}`);
}

// 4. Signal for WP-364: domains in Pack but missing from graph or with <30% coverage
const gapDomains = domainCoverage.filter(
  r => Number(r.coverage_pct) < 50 || Number(r.total) < 5
);
console.log("\n=== Gap Signal for WP-364 (domains < 50% bilingual coverage or < 5 concepts) ===");
if (gapDomains.length === 0) {
  console.log("  No critical gaps — all domains ≥ 50% bilingual coverage.");
} else {
  for (const r of gapDomains) {
    console.log(`  [GAP] ${r.domain}: ${r.coverage_pct}% bilingual (${r.bilingual}/${r.total} concepts)`);
  }
}

// 5. View export stats
const viewRows = await sql`
  SELECT COUNT(*) AS n, COUNT(DISTINCT domain) AS domains
  FROM concept_graph.concept_glossary_export
`;
console.log(`\nGlossary export view: ${viewRows[0].n} rows across ${viewRows[0].domains} domains`);
console.log("View ready for WP-415 translate.py consumption.");

console.log("\n=== Ф-D complete ===");
