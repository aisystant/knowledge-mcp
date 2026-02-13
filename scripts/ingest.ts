#!/usr/bin/env npx tsx
/**
 * Knowledge MCP — Data Ingestion Script (Neon + Cloudflare Workers AI)
 *
 * Reads markdown files from Pack/DS/guides repos and indexes them into
 * Neon PostgreSQL with embeddings from Cloudflare Workers AI.
 *
 * Usage:
 *   npx tsx scripts/ingest.ts --source PACK-digital-platform --type pack --path ~/Github/PACK-digital-platform/pack
 *   npx tsx scripts/ingest.ts --config scripts/sources.json   # bulk ingest from config
 *
 * Environment variables (or .dev.vars file):
 *   DATABASE_URL — Neon PostgreSQL connection string
 *   CLOUDFLARE_ACCOUNT_ID — Cloudflare account ID (for Workers AI)
 *   CLOUDFLARE_API_TOKEN — Cloudflare API token (for Workers AI)
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, relative, extname } from "path";
import { createHash } from "crypto";
import { neon } from "@neondatabase/serverless";

// --- Config ---

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const EMBEDDING_DIM = 768;
const BATCH_SIZE = 10;
const SKIP_PATTERNS = [
  /node_modules/,
  /\.git\//,
  /\.obsidian/,
  /dist\//,
  /build\//,
  /__pycache__/,
  /\.env/,
];

// --- Types ---

interface SourceConfig {
  source: string;
  source_type: "pack" | "guides" | "ds";
  path: string;
  exclude?: string[];
}

// --- Cloudflare Workers AI (REST API) ---

async function getEmbeddings(
  accountId: string,
  apiToken: string,
  texts: string[]
): Promise<number[][]> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${EMBEDDING_MODEL}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: texts }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Cloudflare AI error: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { result: { data: number[][] }; success: boolean };
  if (!data.success) throw new Error("Cloudflare AI: request failed");
  return data.result.data;
}

// --- File scanning ---

function shouldSkip(filepath: string, extraExclude?: string[]): boolean {
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(filepath)) return true;
  }
  if (extraExclude) {
    for (const pattern of extraExclude) {
      if (filepath.includes(pattern)) return true;
    }
  }
  return false;
}

function scanMarkdownFiles(basePath: string, extraExclude?: string[]): { filepath: string; relative: string }[] {
  const results: { filepath: string; relative: string }[] = [];

  function walk(dir: string) {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const relPath = relative(basePath, fullPath);

      if (shouldSkip(relPath, extraExclude)) continue;

      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (extname(entry) === ".md" && stat.size > 0 && stat.size < 100_000) {
        results.push({ filepath: fullPath, relative: relPath });
      }
    }
  }

  walk(basePath);
  return results;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// --- Main ingestion ---

async function ingestSource(
  config: SourceConfig,
  sql: ReturnType<typeof neon>,
  accountId: string,
  apiToken: string
): Promise<number> {
  const { source, source_type, path: basePath } = config;

  const resolvedPath = basePath.replace("~", process.env.HOME || "");
  if (!existsSync(resolvedPath)) {
    console.error(`  Path not found: ${resolvedPath}`);
    return 0;
  }

  console.log(`\n  Scanning ${resolvedPath}...`);
  const files = scanMarkdownFiles(resolvedPath, config.exclude);
  console.log(`  Found ${files.length} markdown files`);

  if (files.length === 0) return 0;

  // Read files and compute hashes
  const documents: { filename: string; content: string; hash: string }[] = [];
  for (const file of files) {
    const content = readFileSync(file.filepath, "utf-8");
    if (content.trim().length < 10) continue;
    documents.push({
      filename: file.relative,
      content,
      hash: contentHash(content),
    });
  }

  console.log(`  ${documents.length} documents to process`);

  // Check existing hashes
  const existingRows = await sql(
    "SELECT filename, hash FROM documents WHERE source = $1",
    [source]
  );
  const existingHashes = new Map<string, string>();
  for (const row of existingRows) {
    existingHashes.set(row.filename as string, row.hash as string);
  }

  // Filter to new/changed
  const toIndex = documents.filter((d) => existingHashes.get(d.filename) !== d.hash);
  const unchanged = documents.length - toIndex.length;
  if (unchanged > 0) console.log(`  ${unchanged} unchanged (skipped)`);
  if (toIndex.length === 0) {
    console.log(`  Nothing to index`);
    return 0;
  }

  console.log(`  Indexing ${toIndex.length} documents...`);

  // Process in batches
  let indexed = 0;
  for (let i = 0; i < toIndex.length; i += BATCH_SIZE) {
    const batch = toIndex.slice(i, i + BATCH_SIZE);
    const texts = batch.map((d) => d.content.slice(0, 8000));

    const embeddings = await getEmbeddings(accountId, apiToken, texts);

    for (let j = 0; j < batch.length; j++) {
      const doc = batch[j];
      const embeddingStr = `[${embeddings[j].join(",")}]`;

      await sql(
        `INSERT INTO documents (filename, content, source, source_type, hash, embedding)
         VALUES ($1, $2, $3, $4, $5, $6::vector)
         ON CONFLICT (filename, source)
         DO UPDATE SET content = $2, source_type = $4, hash = $5, embedding = $6::vector`,
        [doc.filename, doc.content, source, source_type, doc.hash, embeddingStr]
      );
    }

    indexed += batch.length;
    console.log(`  ${indexed}/${toIndex.length} indexed`);

    if (i + BATCH_SIZE < toIndex.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return indexed;
}

// --- CLI ---

async function main() {
  const args = process.argv.slice(2);

  // Load env from .dev.vars
  const env: Record<string, string> = {
    DATABASE_URL: process.env.DATABASE_URL || "",
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || "",
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || "",
  };

  const devVarsPath = join(__dirname, "../.dev.vars");
  if (existsSync(devVarsPath)) {
    const vars = readFileSync(devVarsPath, "utf-8");
    for (const line of vars.split("\n")) {
      const match = line.match(/^(\w+)\s*=\s*(.+)$/);
      if (match) env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }

  if (!env.DATABASE_URL || !env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    console.error("Missing env vars: DATABASE_URL, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN");
    console.error("Set them in environment or in .dev.vars file");
    process.exit(1);
  }

  const sql = neon(env.DATABASE_URL);

  if (args.includes("--config")) {
    const configPath = args[args.indexOf("--config") + 1];
    const configs: SourceConfig[] = JSON.parse(readFileSync(configPath, "utf-8"));
    console.log(`Ingesting ${configs.length} sources from ${configPath}`);
    let total = 0;
    for (const config of configs) {
      console.log(`\n[${config.source}] (${config.source_type})`);
      total += await ingestSource(config, sql, env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN);
    }
    console.log(`\nDone. Total indexed: ${total}`);
  } else {
    const sourceIdx = args.indexOf("--source");
    const typeIdx = args.indexOf("--type");
    const pathIdx = args.indexOf("--path");

    if (sourceIdx === -1 || typeIdx === -1 || pathIdx === -1) {
      console.error("Usage: npx tsx scripts/ingest.ts --source NAME --type pack|guides|ds --path /path/to/repo");
      console.error("       npx tsx scripts/ingest.ts --config scripts/sources.json");
      process.exit(1);
    }

    const config: SourceConfig = {
      source: args[sourceIdx + 1],
      source_type: args[typeIdx + 1] as "pack" | "guides" | "ds",
      path: args[pathIdx + 1],
    };

    console.log(`Ingesting [${config.source}] (${config.source_type}) from ${config.path}`);
    const count = await ingestSource(config, sql, env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN);
    console.log(`\nDone. Indexed: ${count}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
