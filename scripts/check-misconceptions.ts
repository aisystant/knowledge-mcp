#!/usr/bin/env npx tsx
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { neon } from "@neondatabase/serverless";

const __dirname = dirname(fileURLToPath(import.meta.url));
const vars = readFileSync(join(__dirname, "../.dev.vars"), "utf-8");
const dbUrlMatch = vars.match(/DATABASE_URL=(.+)/);
const sql = neon(dbUrlMatch![1].trim().replace("-pooler", ""));

const [count] = await sql`SELECT COUNT(*)::int as cnt FROM concept_graph.concept_misconceptions`;
console.log("Total misconceptions:", count.cnt);

const samples = await sql`
  SELECT cm.concept_id, cm.misconception_text, cm.category, c.code, c.name
  FROM concept_graph.concept_misconceptions cm
  JOIN concept_graph.concepts c ON c.id = cm.concept_id
  LIMIT 5
`;
console.log("\nSamples:");
for (const s of samples) {
  console.log(`  concept_id=${s.concept_id} code=${s.code} name=${s.name} → "${s.misconception_text}" [${s.category}]`);
}

// Check if CAT.001 codes exist as concepts
const catCodes = await sql`
  SELECT code FROM concept_graph.concepts WHERE code LIKE 'CAT.%' LIMIT 5
`;
console.log("\nCAT codes in concepts:", catCodes.length > 0 ? catCodes : "NONE");
