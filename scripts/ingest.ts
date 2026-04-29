#!/usr/bin/env npx tsx
/**
 * Knowledge MCP — Data Ingestion Script (Neon + OpenAI Embeddings)
 *
 * Reads markdown files from Pack/DS/guides repos and indexes them into
 * Neon PostgreSQL `public.knowledge_chunk` (post WP-268 schema) with
 * embeddings from OpenAI (text-embedding-3-small, 1024d).
 *
 * Schema mapping (WP-268 cut-over, 28 апр 2026):
 *   knowledge.documents (legacy)  →  public.knowledge_chunk (new)
 *   filename                      →  source_uri + document_path
 *   content                       →  content
 *   source                        →  source
 *   source_type                   →  source_kind
 *   hash                          →  content_hash + hash
 *   embedding                     →  embedding
 *   parent_id (FK к id)           →  parent_chunk_id (FK к chunk_uuid)
 *   user_id                       →  account_id (NULL для platform)
 *
 * Все sources в sources.json — platform-wide (no user_id) → collection_kind='platform'.
 *
 * Usage:
 *   npx tsx scripts/ingest.ts --source PACK-digital-platform --type pack --path ~/IWE/PACK-digital-platform/pack
 *   npx tsx scripts/ingest.ts --config scripts/sources.json   # bulk ingest from config
 *
 * Environment variables (or .dev.vars file):
 *   DATABASE_URL — Neon PostgreSQL connection string (knowledge DB)
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
const LARGE_FILE_THRESHOLD = CHUNK_CHAR_LIMIT;
const VERY_LARGE_WARNING = 50_000;
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
  user_id?: string; // зарезервировано на будущее (personal collections)
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

// --- Hierarchical chunking for large files (unchanged from legacy ingest) ---

export function chunkLargeFile(
  content: string,
  filename: string
): { filename: string; content: string }[] {
  const chunks: { filename: string; content: string }[] = [];

  const titleMatch = content.match(/^#\s+(.+)/m);
  const docTitle = titleMatch ? titleMatch[1].trim() : "";

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

// --- Main ingestion (REFACTORED to public.knowledge_chunk) ---

async function ingestSource(
  config: SourceConfig,
  sql: ReturnType<typeof neon>,
  apiKey: string
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

  // Read files and compute hashes (chunk large files)
  const documents: { filename: string; content: string; hash: string; parentFile?: string; isParent?: boolean }[] = [];
  for (const file of files) {
    const content = readFileSync(file.filepath, "utf-8");
    if (content.trim().length < 10) continue;

    if (content.length > LARGE_FILE_THRESHOLD) {
      const chunks = chunkLargeFile(content, file.relative);
      const parentHash = contentHash(content);
      const sizeKB = (content.length / 1024).toFixed(0);
      const warn = content.length > VERY_LARGE_WARNING ? " ⚠️  consider splitting" : "";
      console.log(`  ${file.relative}: large file (${sizeKB}KB) → ${chunks.length} chunks + parent${warn}`);

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

  // Check existing hashes (platform collection only)
  const existingRows = await sql`
    SELECT source_uri, content_hash
    FROM public.knowledge_chunk
    WHERE source = ${source} AND collection_kind = 'platform'
  ` as { source_uri: string; content_hash: string }[];
  const existingHashes = new Map<string, string>();
  for (const row of existingRows) {
    existingHashes.set(row.source_uri, row.content_hash);
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

  // Delete existing rows for changed parents (and their chunks) + standalone changed files
  const changedParents = new Set(
    toIndex.filter((d) => d.parentFile).map((d) => d.parentFile!)
  );
  const standaloneChanged = toIndex.filter((d) => !d.parentFile && !d.isParent).map((d) => d.filename);

  for (const parentFile of changedParents) {
    // Delete parent + all its chunks (LIKE 'parent::%' и сам parent)
    await sql`
      DELETE FROM public.knowledge_chunk
      WHERE source = ${source}
        AND collection_kind = 'platform'
        AND (source_uri = ${parentFile} OR source_uri LIKE ${parentFile + '::%'})
    `;
    console.log(`  Cleaned old parent + chunks for ${parentFile}`);
  }
  // Delete changed standalone files
  if (standaloneChanged.length > 0) {
    await sql`
      DELETE FROM public.knowledge_chunk
      WHERE source = ${source}
        AND collection_kind = 'platform'
        AND source_uri = ANY(${standaloneChanged}::text[])
    `;
  }

  // Phase 1: Insert parent documents (no embeddings — too large for meaningful vectors)
  // Returns chunk_uuid for FK linkage to chunks.
  const parents = toIndex.filter((d) => d.isParent);
  const parentUuids = new Map<string, string>(); // filename -> chunk_uuid

  for (const parent of parents) {
    const chunkId = `${parent.filename}::p0`;
    const result = await sql`
      INSERT INTO public.knowledge_chunk (
        chunk_id, document_path, paragraph_pos, content_hash, hash,
        source, source_uri, source_kind, collection_kind,
        content, embedding, indexed_at
      )
      VALUES (
        ${chunkId}, ${parent.filename}, 0, ${parent.hash}, ${parent.hash},
        ${source}, ${parent.filename}, ${source_type}, 'platform',
        ${parent.content}, NULL, NOW()
      )
      RETURNING chunk_uuid
    ` as { chunk_uuid: string }[];
    parentUuids.set(parent.filename, result[0].chunk_uuid);
  }
  if (parents.length > 0) {
    console.log(`  ${parents.length} parent documents stored`);
  }

  // Phase 2: Insert chunks with embeddings and parent_chunk_id links
  const chunks = toIndex.filter((d) => !d.isParent);
  let indexed = 0;
  let posCounter: Record<string, number> = {};

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((d) => d.content.slice(0, CHUNK_CHAR_LIMIT));

    const embeddings = await getEmbeddings(apiKey, texts);

    for (let j = 0; j < batch.length; j++) {
      const doc = batch[j];
      const embeddingStr = `[${embeddings[j].join(",")}]`;
      const groupKey = doc.parentFile ?? doc.filename;
      const pos = (posCounter[groupKey] ?? 0) + 1; // chunks start at paragraph_pos = 1 (parent = 0)
      posCounter[groupKey] = pos;

      const chunkId = `${doc.filename}::p${pos}`;
      const parentUuid = doc.parentFile ? parentUuids.get(doc.parentFile) ?? null : null;

      await sql`
        INSERT INTO public.knowledge_chunk (
          chunk_id, document_path, paragraph_pos, content_hash, hash,
          source, source_uri, source_kind, collection_kind,
          content, embedding, parent_chunk_id, indexed_at
        )
        VALUES (
          ${chunkId}, ${doc.filename}, ${pos}, ${doc.hash}, ${doc.hash},
          ${source}, ${doc.filename}, ${source_type}, 'platform',
          ${doc.content}, ${embeddingStr}::vector, ${parentUuid}::uuid, NOW()
        )
      `;
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

    if (args.includes("--clean")) {
      const deleted = await sql`
        DELETE FROM public.knowledge_chunk
        WHERE source = ${config.source} AND collection_kind = 'platform'
      `;
      console.log(`Cleaned ${(deleted as any).length ?? 0} old entries for [${config.source}]`);
    }

    console.log(`Ingesting [${config.source}] (${config.source_type}) from ${config.path}`);
    const count = await ingestSource(config, sql, env.OPENAI_API_KEY);
    console.log(`\nDone. Indexed: ${count}`);
  }
}

const isDirectRun = process.argv[1]?.endsWith("ingest.ts") || process.argv[1]?.endsWith("ingest.js");
if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
