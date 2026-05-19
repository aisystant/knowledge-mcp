#!/usr/bin/env npx tsx
/**
 * Smoke test for concept-indexer.ts — removed action
 */

import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { reindexConceptsForFiles } from "../src/concept-indexer.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const devVarsPath = join(__dirname, "../.dev.vars");
const vars = readFileSync(devVarsPath, "utf-8");
for (const line of vars.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.+)/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].trim();
  }
}

const env = {
  KNOWLEDGE_DATABASE_URL: process.env.DATABASE_URL!,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
};

const source = "PACK-digital-platform";
const filePath = "pack/digital-platform/02-domain-entities/DP.AISYS.013-knowledge-extractor.md";

async function readFile(_path: string): Promise<string | null> {
  return null;
}

async function main() {
  console.log("=== Test reindexConceptsForFiles (removed) ===\n");

  const result = await reindexConceptsForFiles(env, source, [
    { path: filePath, action: "removed" },
  ], readFile);

  console.log("Result:", JSON.stringify(result, null, 2));
}

main().catch(console.error);
