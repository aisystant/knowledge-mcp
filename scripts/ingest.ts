#!/usr/bin/env npx tsx
/**
 * Knowledge MCP — Data Ingestion Script
 *
 * Reads markdown files from Pack/DS/guides repos and indexes them into SurrealDB
 * with embeddings for semantic search.
 *
 * Usage:
 *   npx tsx scripts/ingest.ts --source PACK-digital-platform --type pack --path ~/Github/PACK-digital-platform/pack
 *   npx tsx scripts/ingest.ts --source PACK-personal --type pack --path ~/Github/PACK-personal/pack
 *   npx tsx scripts/ingest.ts --source DS-ecosystem-development --type ds --path ~/Github/DS-ecosystem-development
 *   npx tsx scripts/ingest.ts --config scripts/sources.json   # bulk ingest from config
 *
 * Environment variables (or .dev.vars file):
 *   SURREAL_HOST, SURREAL_USER, SURREAL_PASSWORD, OPENAI_API_KEY
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, relative, extname } from "path";
import { createHash } from "crypto";

// --- Config ---

const EMBEDDING_MODEL = "text-embedding-3-large";
const TABLE_NAME = "documents";
const DEFAULT_DB = "knowledge";
const BATCH_SIZE = 10; // documents per embedding batch
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
  include?: string[];  // glob patterns, default: ["**/*.md"]
  exclude?: string[];  // additional exclude patterns
}

interface DocumentRecord {
  filename: string;
  content: string;
  source: string;
  source_type: string;
  hash: string;
  embedding: number[];
}

// --- SurrealDB ---

async function surrealSignin(host: string, user: string, password: string): Promise<string> {
  const response = await fetch(`${host}/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ns: user, user, pass: password }),
  });
  if (!response.ok) throw new Error(`SurrealDB signin: ${response.status} ${await response.text()}`);
  const data = (await response.json()) as { token: string };
  return data.token;
}

async function surrealExec(host: string, user: string, password: string, query: string): Promise<unknown[]> {
  const token = await surrealSignin(host, user, password);
  const response = await fetch(`${host}/sql`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      Accept: "application/json",
      "surreal-ns": user,
      "surreal-db": DEFAULT_DB,
      Authorization: `Bearer ${token}`,
    },
    body: query,
  });
  if (!response.ok) throw new Error(`SurrealDB query: ${response.status} ${await response.text()}`);
  return (await response.json()) as unknown[];
}

// --- OpenAI Embeddings ---

async function getEmbeddings(apiKey: string, texts: string[]): Promise<number[][]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: texts, model: EMBEDDING_MODEL }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI error: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { data: { embedding: number[]; index: number }[] };
  return data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
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

async function ingestSource(config: SourceConfig, env: Record<string, string>): Promise<number> {
  const { source, source_type, path: basePath } = config;

  if (!existsSync(basePath)) {
    console.error(`  Path not found: ${basePath}`);
    return 0;
  }

  console.log(`\n  Scanning ${basePath}...`);
  const files = scanMarkdownFiles(basePath, config.exclude);
  console.log(`  Found ${files.length} markdown files`);

  if (files.length === 0) return 0;

  // Read all files and compute hashes
  const documents: { filename: string; content: string; hash: string }[] = [];
  for (const file of files) {
    const content = readFileSync(file.filepath, "utf-8");
    if (content.trim().length < 10) continue; // skip near-empty
    documents.push({
      filename: file.relative,
      content,
      hash: contentHash(content),
    });
  }

  console.log(`  ${documents.length} documents to process`);

  // Check existing hashes to skip unchanged documents
  const existingResult = await surrealExec(
    env.SURREAL_HOST,
    env.SURREAL_USER,
    env.SURREAL_PASSWORD,
    `SELECT filename, hash FROM ${TABLE_NAME} WHERE source = '${source.replace(/'/g, "\\'")}'`
  );
  const existingHashes = new Map<string, string>();
  const rows = (existingResult[0] as any)?.result;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      existingHashes.set(row.filename, row.hash);
    }
  }

  // Filter to only new/changed documents
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
    const texts = batch.map((d) => d.content.slice(0, 8000)); // truncate for embedding

    // Generate embeddings
    const embeddings = await getEmbeddings(env.OPENAI_API_KEY, texts);

    // Upsert into SurrealDB
    for (let j = 0; j < batch.length; j++) {
      const doc = batch[j];
      const embedding = embeddings[j];
      const escapedFilename = doc.filename.replace(/'/g, "\\'");
      const escapedContent = doc.content.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const embeddingStr = `[${embedding.join(",")}]`;

      // Use UPSERT: if filename+source exists, update; else insert
      const query = `
        DELETE FROM ${TABLE_NAME} WHERE filename = '${escapedFilename}' AND source = '${source.replace(/'/g, "\\'")}';
        CREATE ${TABLE_NAME} SET
          filename = '${escapedFilename}',
          content = '${escapedContent}',
          source = '${source}',
          source_type = '${source_type}',
          hash = '${doc.hash}',
          embedding = ${embeddingStr};
      `;

      await surrealExec(env.SURREAL_HOST, env.SURREAL_USER, env.SURREAL_PASSWORD, query);
    }

    indexed += batch.length;
    console.log(`  ${indexed}/${toIndex.length} indexed`);

    // Rate limit: pause between batches
    if (i + BATCH_SIZE < toIndex.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return indexed;
}

// --- CLI ---

async function main() {
  const args = process.argv.slice(2);

  // Load env from .dev.vars if exists
  const env: Record<string, string> = {
    SURREAL_HOST: process.env.SURREAL_HOST || "https://surrealdb.aisystant.com",
    SURREAL_USER: process.env.SURREAL_USER || "",
    SURREAL_PASSWORD: process.env.SURREAL_PASSWORD || "",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  };

  const devVarsPath = join(__dirname, "../.dev.vars");
  if (existsSync(devVarsPath)) {
    const vars = readFileSync(devVarsPath, "utf-8");
    for (const line of vars.split("\n")) {
      const match = line.match(/^(\w+)\s*=\s*(.+)$/);
      if (match) env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }

  if (!env.SURREAL_USER || !env.SURREAL_PASSWORD || !env.OPENAI_API_KEY) {
    console.error("Missing env vars: SURREAL_USER, SURREAL_PASSWORD, OPENAI_API_KEY");
    console.error("Set them in environment or in .dev.vars file");
    process.exit(1);
  }

  // Parse CLI args
  if (args.includes("--config")) {
    // Bulk mode: read from config file
    const configPath = args[args.indexOf("--config") + 1];
    const configs: SourceConfig[] = JSON.parse(readFileSync(configPath, "utf-8"));
    console.log(`Ingesting ${configs.length} sources from ${configPath}`);
    let total = 0;
    for (const config of configs) {
      console.log(`\n[${config.source}] (${config.source_type})`);
      total += await ingestSource(config, env);
    }
    console.log(`\nDone. Total indexed: ${total}`);
  } else {
    // Single source mode
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
      path: args[pathIdx + 1].replace("~", process.env.HOME || ""),
    };

    console.log(`Ingesting [${config.source}] (${config.source_type}) from ${config.path}`);
    const count = await ingestSource(config, env);
    console.log(`\nDone. Indexed: ${count}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
