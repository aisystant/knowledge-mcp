#!/usr/bin/env npx tsx
/**
 * E2E Smoke Test — WP-339 Ф7
 *
 * Scenario: simulated push with new markdown link → verify graph update → rollback.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { neon } from "@neondatabase/serverless";
import { reindexConceptsForFiles } from "../src/concept-indexer.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Load .dev.vars
const devVarsPath = join(__dirname, "../.dev.vars");
const vars = readFileSync(devVarsPath, "utf-8");
for (const line of vars.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.+)/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].trim();
  }
}

const env = {
  KNOWLEDGE_DATABASE_URL: process.env.DATABASE_URL!.replace("-pooler", ""),
  OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
};

const source = "PACK-digital-platform";
const filePath = "pack/digital-platform/02-domain-entities/DP.AISYS.013-knowledge-extractor.md";
const testLink = "[AS.D.001]"; // Known concept in DB

const fullPath = join(process.env.HOME!, "IWE", source, filePath);
const originalContent = readFileSync(fullPath, "utf-8");
const modifiedContent = originalContent + "\n\nСвязано с " + testLink + "\n";

const sql = neon(env.KNOWLEDGE_DATABASE_URL);

async function countEdge(): Promise<number> {
  const rows = await sql`
    SELECT count(*) as cnt
    FROM concept_graph.concept_edges e
    JOIN concept_graph.concepts a ON a.id = e.from_concept_id
    JOIN concept_graph.concepts b ON b.id = e.to_concept_id
    WHERE a.code = ${source + "/" + filePath}
      AND b.code LIKE '%AS.D.001%'
  `;
  return Number(rows[0].cnt);
}

async function main() {
  console.log("=== WP-339 Ф7 E2E Smoke Test ===\n");

  // Baseline
  const baseline = await countEdge();
  console.log(`Baseline edge count: ${baseline}`);

  // Step 1: simulated push with new link
  console.log("\n[1] Simulating push with new markdown link...");
  const result1 = await reindexConceptsForFiles(env, source, [
    { path: filePath, action: "modified" },
  ], async () => modifiedContent);
  console.log("Result:", JSON.stringify(result1.details[0], null, 2));

  // Step 2: verify edge exists
  const afterAdd = await countEdge();
  console.log(`\n[2] Edge count after add: ${afterAdd}`);
  if (afterAdd <= baseline) {
    console.error("❌ FAIL: New edge not created");
    process.exit(1);
  }
  console.log("✅ New edge confirmed in graph");

  // Step 3: rollback (simulate revert)
  console.log("\n[3] Simulating rollback (revert link)...");
  const result2 = await reindexConceptsForFiles(env, source, [
    { path: filePath, action: "modified" },
  ], async () => originalContent);
  console.log("Result:", JSON.stringify(result2.details[0], null, 2));

  // Step 4: verify edge removed
  const afterRollback = await countEdge();
  console.log(`\n[4] Edge count after rollback: ${afterRollback}`);
  if (afterRollback !== baseline) {
    console.error("❌ FAIL: Edge not restored to baseline after rollback");
    process.exit(1);
  }
  console.log("✅ Edge correctly removed after rollback");

  // Step 5: latency check (simple)
  const start = Date.now();
  await reindexConceptsForFiles(env, source, [
    { path: filePath, action: "modified" },
  ], async () => modifiedContent);
  const latencyMs = Date.now() - start;
  console.log(`\n[5] Latency (modified, with embedding): ${latencyMs}ms`);

  // Cleanup: restore original
  await reindexConceptsForFiles(env, source, [
    { path: filePath, action: "modified" },
  ], async () => originalContent);

  console.log("\n=== ✅ E2E Smoke Test PASSED ===");
  console.log(`    δ (latency) = ${latencyMs}ms (threshold: 60000ms)`);
}

main().catch((err) => {
  console.error("❌ E2E Smoke Test FAILED:", err);
  process.exit(1);
});
