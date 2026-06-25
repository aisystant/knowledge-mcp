#!/usr/bin/env npx tsx
/**
 * WP-439 Ф2 probe (READ-ONLY) — assess specializes-inheritance feasibility.
 *
 * Answers the design questions before implementing Ф2:
 *  - how many specializes edges exist;
 *  - how many concepts have a specializes-parent that already carries name_en;
 *  - of those, how many children lack name_en (inheritance candidates) vs
 *    already have one (potential drift);
 *  - children-per-parent distribution (high counts => variant A "inherit exact
 *    parent name" would create many duplicate name_en);
 *  - level/domain breakdown (which level holds РР guide concepts);
 *  - guide concepts with no name_en AND no name_en-bearing parent (review queue).
 *
 * No writes. Mirrors loadDevVars/neon pattern from wp439-apply-anchor.ts.
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

const specEdges = await sql`
  SELECT count(*)::int AS n FROM concept_graph.concept_edges WHERE edge_type = 'specializes'
`;
console.log(`specializes edges total: ${specEdges[0].n}`);

const inherit = await sql`
  SELECT
    count(*)::int AS total,
    count(*) FILTER (WHERE c.name_en IS NULL)::int AS child_no_en,
    count(*) FILTER (WHERE c.name_en IS NOT NULL AND c.name_en_source IN ('unknown','llm'))::int AS child_unaudited,
    count(*) FILTER (WHERE c.name_en IS NOT NULL AND c.name_en_source IN ('fpf','glossary','manual','inherited'))::int AS child_protected
  FROM concept_graph.concept_edges e
  JOIN concept_graph.concepts c ON c.id = e.from_concept_id
  JOIN concept_graph.concepts p ON p.id = e.to_concept_id
  WHERE e.edge_type = 'specializes' AND p.name_en IS NOT NULL AND c.status = 'active'
`;
console.log("\nchildren with a name_en-bearing specializes-parent:");
console.log(`  total: ${inherit[0].total}`);
console.log(`  child has NO name_en (inherit candidates): ${inherit[0].child_no_en}`);
console.log(`  child name_en is unaudited (unknown/llm): ${inherit[0].child_unaudited}`);
console.log(`  child name_en is protected (fpf/glossary/manual/inherited): ${inherit[0].child_protected}`);

const perParent = await sql`
  SELECT p.code, p.name_en, count(*)::int AS children
  FROM concept_graph.concept_edges e
  JOIN concept_graph.concepts c ON c.id = e.from_concept_id
  JOIN concept_graph.concepts p ON p.id = e.to_concept_id
  WHERE e.edge_type = 'specializes' AND p.name_en IS NOT NULL AND c.status = 'active'
  GROUP BY p.code, p.name_en
  ORDER BY children DESC
  LIMIT 12
`;
console.log("\ntop name_en-bearing parents by child count (variant-A duplicate risk):");
for (const r of perParent) {
  console.log(`  ${r.code} (${r.name_en}): ${r.children} children`);
}

const byLevel = await sql`
  SELECT level,
    count(*)::int AS n,
    count(*) FILTER (WHERE name_en IS NULL)::int AS no_en
  FROM concept_graph.concepts
  WHERE status = 'active'
  GROUP BY level
  ORDER BY n DESC
`;
console.log("\nconcepts by level (n / without name_en):");
for (const r of byLevel) {
  console.log(`  ${r.level}: ${r.n} / ${r.no_en} no_en`);
}

const guideOrphans = await sql`
  SELECT count(*)::int AS n
  FROM concept_graph.concepts c
  WHERE c.status = 'active' AND c.level = 'guide' AND c.name_en IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM concept_graph.concept_edges e
      JOIN concept_graph.concepts p ON p.id = e.to_concept_id
      WHERE e.from_concept_id = c.id AND e.edge_type = 'specializes' AND p.name_en IS NOT NULL
    )
`;
console.log(`\nguide concepts with NO name_en and NO name_en-bearing parent (review queue): ${guideOrphans[0].n}`);

// Ф2 views (present only after migration 018) — verify row counts.
const viewCheck = await sql`
  SELECT count(*)::int AS n FROM information_schema.views
  WHERE table_schema = 'concept_graph'
    AND table_name IN ('concept_kind_context', 'concept_translation_orphans')
`;
if (viewCheck[0].n === 2) {
  const kc = await sql`SELECT count(*)::int AS n FROM concept_graph.concept_kind_context`;
  const orphans = await sql`SELECT count(*)::int AS n FROM concept_graph.concept_translation_orphans`;
  console.log(`\nФ2 views: concept_kind_context=${kc[0].n} rows, concept_translation_orphans=${orphans[0].n} rows`);
} else {
  console.log(`\nФ2 views not yet created (${viewCheck[0].n}/2)`);
}
