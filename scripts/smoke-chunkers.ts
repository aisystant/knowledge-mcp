#!/usr/bin/env npx tsx
/**
 * Smoke test for WP-443 chunker A/B comparison.
 * Compares legacy chunkLargeFile vs systemChunkFile on real markdown files.
 * Does NOT write to the database.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { chunkLargeFile, systemChunkFile } from "./ingest.js";

const PACK_DIR = "/Users/tserentserenov/IWE/PACK-digital-platform/pack";
const LARGE_FILE_THRESHOLD = 10_000;

function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(current: string) {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".md")) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

async function main() {
  const files = findMarkdownFiles(PACK_DIR).filter((f) => {
    const content = readFileSync(f, "utf-8");
    return content.length > LARGE_FILE_THRESHOLD;
  });

  if (files.length === 0) {
    console.log("FAIL: no large markdown files found");
    process.exit(1);
  }

  let totalLegacyChunks = 0;
  let totalSystemChunks = 0;
  let totalFiles = 0;

  for (const file of files.slice(0, 20)) {
    const content = readFileSync(file, "utf-8");
    const legacy = chunkLargeFile(content, file);
    const system = await systemChunkFile(content, file);
    totalLegacyChunks += legacy.length;
    totalSystemChunks += system.length;
    totalFiles += 1;
  }

  console.log(`Smoke test on ${totalFiles} large files`);
  console.log(`Legacy chunks: ${totalLegacyChunks}`);
  console.log(`System chunks: ${totalSystemChunks}`);

  if (totalSystemChunks >= totalLegacyChunks && totalSystemChunks > 0) {
    console.log("PASS: system chunker produces comparable or finer granularity");
    process.exit(0);
  } else {
    console.log("FAIL: system chunker produced fewer chunks than legacy");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
