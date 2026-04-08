#!/usr/bin/env npx tsx
/**
 * Knowledge MCP — Data Ingestion Script (Neon + OpenAI Embeddings)
 *
 * Reads markdown files from Pack/DS/guides repos and indexes them into
 * Neon PostgreSQL with embeddings from OpenAI (text-embedding-3-small, 1024d).
 *
 * Usage:
 *   npx tsx scripts/ingest.ts --source PACK-digital-platform --type pack --path ~/IWE/PACK-digital-platform/pack
 *   npx tsx scripts/ingest.ts --config scripts/sources.json   # bulk ingest from config
 *
 * Environment variables (or .dev.vars file):
 *   DATABASE_URL — Neon PostgreSQL connection string
 *   OPENAI_API_KEY — OpenAI API key
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, relative, extname, dirname } from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { neon } from "@neondatabase/serverless";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Config ---

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIM = 1024;
const BATCH_SIZE = 10;
const CHUNK_CHAR_LIMIT = 10_000;
const LARGE_FILE_THRESHOLD = CHUNK_CHAR_LIMIT; // Files above CHUNK_CHAR_LIMIT get chunked by ## headers
const VERY_LARGE_WARNING = 50_000; // Warn about files >50K — consider splitting
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
  source_type: "pack" | "guides" | "ds" | "content";
  path: string;
  exclude?: string[];
  user_id?: string;
}

// --- OpenAI Embeddings (REST API) ---

async function getEmbeddings(
  apiKey: string,
  texts: string[]
): Promise<number[][]> {
  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: texts,
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIM,
      }),
    });

    if (response.status === 429) {
      const wait = Math.pow(2, attempt + 1) * 1000;
      console.log(`  Rate limited, waiting ${wait / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI Embeddings error: ${response.status} ${text}`);
    }

    const data = (await response.json()) as {
      data: { embedding: number[] }[];
    };
    return data.data.map((d) => d.embedding);
  }
  throw new Error("OpenAI Embeddings: max retries exceeded (rate limited)");
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
      } else if (extname(entry) === ".md" && stat.size > 0) {
        results.push({ filepath: fullPath, relative: relPath });
      }
    }
  }

  walk(basePath);
  return results;
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// --- Hierarchical chunking for large files ---

export function chunkLargeFile(
  content: string,
  filename: string
): { filename: string; content: string }[] {
  const chunks: { filename: string; content: string }[] = [];

  // Extract document title for breadcrumb prefix
  const titleMatch = content.match(/^#\s+(.+)/m);
  const docTitle = titleMatch ? titleMatch[1].trim() : "";

  // Split by ## headers
  const sections = content.split(/^(?=## )/m);

  for (const section of sections) {
    if (section.trim().length < 10) continue;

    const headerMatch = section.match(/^##\s+(.+)/m);
    const sectionName = headerMatch ? headerMatch[1].trim() : "_intro";

    if (section.length <= CHUNK_CHAR_LIMIT) {
      const prefix = docTitle ? `> ${docTitle} > ${sectionName}\n\n` : "";
      chunks.push({
        filename: `${filename}::${sectionName}`,
        content: prefix + section,
      });
    } else {
      // Section too large — split by ### sub-headers
      const subsections = section.split(/^(?=### )/m);

      for (const subsection of subsections) {
        if (subsection.trim().length < 10) continue;

        const subMatch = subsection.match(/^###\s+(.+)/m);
        const subName = subMatch
          ? `${sectionName} > ${subMatch[1].trim()}`
          : sectionName;

        if (subsection.length <= CHUNK_CHAR_LIMIT) {
          const prefix = docTitle ? `> ${docTitle} > ${subName}\n\n` : "";
          chunks.push({
            filename: `${filename}::${subName}`,
            content: prefix + subsection,
          });
        } else {
          // Still too large — split by paragraphs
          const paragraphs = subsection.split(/\n\n+/);
          let accumulator = "";
          let partIndex = 0;

          for (const para of paragraphs) {
            if (
              accumulator.length + para.length + 2 > CHUNK_CHAR_LIMIT &&
              accumulator.length > 0
            ) {
              const prefix = docTitle
                ? `> ${docTitle} > ${subName} (part ${++partIndex})\n\n`
                : "";
              chunks.push({
                filename: `${filename}::${subName}::part${partIndex}`,
                content: prefix + accumulator.trim(),
              });
              accumulator = "";
            }
            accumulator += (accumulator ? "\n\n" : "") + para;
          }

          if (accumulator.trim().length >= 10) {
            if (partIndex > 0) {
              const prefix = docTitle
                ? `> ${docTitle} > ${subName} (part ${++partIndex})\n\n`
                : "";
              chunks.push({
                filename: `${filename}::${subName}::part${partIndex}`,
                content: prefix + accumulator.trim(),
              });
            } else {
              const prefix = docTitle ? `> ${docTitle} > ${subName}\n\n` : "";
              chunks.push({
                filename: `${filename}::${subName}`,
                content: prefix + accumulator.trim(),
              });
            }
          }
        }
      }
    }
  }

  return chunks;
}

// --- Main ingestion ---

async function ingestSource(
  config: SourceConfig,
  sql: ReturnType<typeof neon>,
  apiKey: string
): Promise<number> {
  const { source, source_type, path: basePath, user_id } = config;
  const uid = user_id ?? null;

  const resolvedPath = basePath.replace("~", process.env.HOME || "");
  if (!existsSync(resolvedPath)) {
    console.error(`  Path not found: ${resolvedPath}`);
    return 0;
  }

  console.log(`\n  Scanning ${resolvedPath}...`);
  const files = scanMarkdownFiles(resolvedPath, config.exclude);
  console.log(`  Found ${files.length} markdown files`);

  if (files.length === 0) return 0;

  // Read files and compute hashes (chunk large files)
  // Parent documents: stored without embeddings, linked via parent_id
  const documents: { filename: string; content: string; hash: string; parentFile?: string; isParent?: boolean }[] = [];
  const chunkedParents = new Set<string>();
  for (const file of files) {
    const content = readFileSync(file.filepath, "utf-8");
    if (content.trim().length < 10) continue;

    if (content.length > LARGE_FILE_THRESHOLD) {
      // Large file — store parent document (no embedding) + chunks with parent link
      const chunks = chunkLargeFile(content, file.relative);
      const parentHash = contentHash(content);
      chunkedParents.add(file.relative);
      const sizeKB = (content.length / 1024).toFixed(0);
      const warn = content.length > VERY_LARGE_WARNING ? " ⚠️  consider splitting" : "";
      console.log(`  ${file.relative}: large file (${sizeKB}KB) → ${chunks.length} chunks + parent${warn}`);

      // Parent document: full content, no embedding (too large for meaningful vector)
      documents.push({
        filename: file.relative,
        content,
        hash: parentHash,
        isParent: true,
      });

      for (const chunk of chunks) {
        documents.push({
          filename: chunk.filename,
          content: chunk.content,
          hash: contentHash(chunk.content),
          parentFile: file.relative,
        });
      }
    } else {
      documents.push({
        filename: file.relative,
        content,
        hash: contentHash(content),
      });
    }
  }

  console.log(`  ${documents.length} documents to process`);

  // Check existing hashes
  const existingRows = await sql`
    SELECT filename, hash FROM documents WHERE source = ${source}
  `;
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

  // Delete old chunks for changed large files (ghost cleanup)
  const changedParents = new Set(
    toIndex.filter((d) => d.parentFile).map((d) => d.parentFile!)
  );
  for (const parentFile of changedParents) {
    await sql`DELETE FROM documents WHERE source = ${source} AND filename LIKE ${parentFile + '::%'}`;
    // Also delete old parent document entry
    await sql`DELETE FROM documents WHERE source = ${source} AND filename = ${parentFile}`;
    console.log(`  Cleaned old parent + chunks for ${parentFile}`);
  }

  // Phase 1: Upsert parent documents (no embeddings — too large for meaningful vectors)
  const parents = toIndex.filter((d) => d.isParent);
  for (const parent of parents) {
    await sql`
      INSERT INTO documents (filename, content, source, source_type, hash, embedding, search_vector, user_id)
      VALUES (${parent.filename}, ${parent.content}, ${source}, ${source_type}, ${parent.hash}, NULL, to_tsvector('simple', ${parent.content}), ${uid})
      ON CONFLICT (filename, source)
      DO UPDATE SET content = ${parent.content}, source_type = ${source_type}, hash = ${parent.hash}, embedding = NULL, search_vector = to_tsvector('simple', ${parent.content}), user_id = ${uid}
    `;
  }
  if (parents.length > 0) {
    console.log(`  ${parents.length} parent documents stored`);
  }

  // Phase 2: Upsert chunks with embeddings and parent_id links
  const chunks = toIndex.filter((d) => !d.isParent);
  let indexed = 0;
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((d) => d.content.slice(0, CHUNK_CHAR_LIMIT));

    const embeddings = await getEmbeddings(apiKey, texts);

    for (let j = 0; j < batch.length; j++) {
      const doc = batch[j];
      const embeddingStr = `[${embeddings[j].join(",")}]`;

      if (doc.parentFile) {
        // Chunk with parent link: resolve parent_id from DB
        await sql`
          INSERT INTO documents (filename, content, source, source_type, hash, embedding, search_vector, parent_id, user_id)
          VALUES (
            ${doc.filename}, ${doc.content}, ${source}, ${source_type}, ${doc.hash},
            ${embeddingStr}::vector, to_tsvector('simple', ${doc.content}),
            (SELECT id FROM documents WHERE filename = ${doc.parentFile} AND source = ${source} LIMIT 1),
            ${uid}
          )
          ON CONFLICT (filename, source)
          DO UPDATE SET
            content = ${doc.content}, source_type = ${source_type}, hash = ${doc.hash},
            embedding = ${embeddingStr}::vector, search_vector = to_tsvector('simple', ${doc.content}),
            parent_id = (SELECT id FROM documents WHERE filename = ${doc.parentFile} AND source = ${source} LIMIT 1),
            user_id = ${uid}
        `;
      } else {
        // Regular document (not chunked): no parent
        await sql`
          INSERT INTO documents (filename, content, source, source_type, hash, embedding, search_vector, user_id)
          VALUES (${doc.filename}, ${doc.content}, ${source}, ${source_type}, ${doc.hash}, ${embeddingStr}::vector, to_tsvector('simple', ${doc.content}), ${uid})
          ON CONFLICT (filename, source)
          DO UPDATE SET content = ${doc.content}, source_type = ${source_type}, hash = ${doc.hash}, embedding = ${embeddingStr}::vector, search_vector = to_tsvector('simple', ${doc.content}), user_id = ${uid}
        `;
      }
    }

    indexed += batch.length;
    console.log(`  ${indexed}/${chunks.length} indexed`);

    if (i + BATCH_SIZE < chunks.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return indexed + parents.length;
}

// --- CLI ---

async function main() {
  const args = process.argv.slice(2);

  // Load env from .dev.vars
  const env: Record<string, string> = {
    DATABASE_URL: process.env.DATABASE_URL || "",
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

  if (!env.DATABASE_URL || !env.OPENAI_API_KEY) {
    console.error("Missing env vars: DATABASE_URL, OPENAI_API_KEY");
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
      total += await ingestSource(config, sql, env.OPENAI_API_KEY);
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

    // --clean: delete all existing entries for this source before re-indexing
    if (args.includes("--clean")) {
      const deleted = await sql`DELETE FROM documents WHERE source = ${config.source}`;
      console.log(`Cleaned ${deleted.length ?? 0} old entries for [${config.source}]`);
    }

    console.log(`Ingesting [${config.source}] (${config.source_type}) from ${config.path}`);
    const count = await ingestSource(config, sql, env.OPENAI_API_KEY);
    console.log(`\nDone. Indexed: ${count}`);
  }
}

// Only run main when executed directly (not when imported for testing)
const isDirectRun = process.argv[1]?.endsWith("ingest.ts") || process.argv[1]?.endsWith("ingest.js");
if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
