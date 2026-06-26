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
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Config ---

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIM = 1024;
const BATCH_SIZE = 10;
const CHUNK_CHAR_LIMIT = 10_000;
const LARGE_FILE_THRESHOLD = CHUNK_CHAR_LIMIT;
const VERY_LARGE_WARNING = 50_000;
const CHUNKER_MODE = process.env.KNOWLEDGE_CHUNKER ?? "legacy";
const SYSTEM_CHUNK_SIZE = 2_000;
const SYSTEM_CHUNK_OVERLAP = 200;
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
  user_id?: string; // если задан → personal collection (account_id, collection_kind='personal')
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

// --- System-native recursive chunker (WP-443) ---

export async function systemChunkFile(
  content: string,
  filename: string
): Promise<{ filename: string; content: string }[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: SYSTEM_CHUNK_SIZE,
    chunkOverlap: SYSTEM_CHUNK_OVERLAP,
    separators: ["\n## ", "\n### ", "\n\n", ". ", " ", ""],
  });

  const docs = await splitter.createDocuments([content]);
  return docs.map((doc, index) => ({
    filename: `${filename}::chunk${index + 1}`,
    content: doc.pageContent,
  }));
}

// --- Main ingestion (REFACTORED to public.knowledge_chunk) ---

async function ingestSource(
  config: SourceConfig,
  sql: ReturnType<typeof neon>,
  apiKey: string
): Promise<number> {
  const { source, source_type, path: basePath } = config;
  // Personal vs platform: use user_id from config if present
  const collectionKind = config.user_id ? 'personal' : 'platform';
  const accountId: string | null = config.user_id ?? null;

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
      const chunks = CHUNKER_MODE === "system"
        ? await systemChunkFile(content, file.relative)
        : chunkLargeFile(content, file.relative);
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

      // Dedupe chunk filenames — markdown файлы могут иметь повторяющиеся
      // заголовки (`## Источники` 7×) → одинаковые chunk filenames → нарушение
      // unique index. Suffix #N для дубликатов.
      const seen = new Map<string, number>();
      for (const chunk of chunks) {
        let chunkFilename = chunk.filename;
        const count = seen.get(chunkFilename) ?? 0;
        if (count > 0) {
          chunkFilename = `${chunk.filename}#${count + 1}`;
        }
        seen.set(chunk.filename, count + 1);
        documents.push({
          filename: chunkFilename,
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

  // Check existing hashes for this source + owner
  const existingRows = await sql`
    SELECT source_uri, content_hash
    FROM public.knowledge_chunk
    WHERE source = ${source}
      AND account_id IS NOT DISTINCT FROM ${accountId}::uuid
  ` as { source_uri: string; content_hash: string }[];
  const existingHashes = new Map<string, string>();
  for (const row of existingRows) {
    existingHashes.set(row.source_uri, row.content_hash);
  }

  // Filter to new/changed
  const initialChanged = documents.filter((d) => existingHashes.get(d.filename) !== d.hash);

  // Если изменился parent OR хотя бы один его chunk → все chunks этого parent должны быть
  // переинсёрчены (DELETE сметает все, иначе rows просто исчезнут).
  const dirtyParents = new Set<string>();
  for (const d of initialChanged) {
    if (d.isParent) dirtyParents.add(d.filename);
    if (d.parentFile) dirtyParents.add(d.parentFile);
  }

  const toIndex = documents.filter((d) => {
    if (dirtyParents.has(d.filename) || (d.parentFile && dirtyParents.has(d.parentFile))) return true;
    return existingHashes.get(d.filename) !== d.hash;
  });

  const unchanged = documents.length - toIndex.length;
  if (unchanged > 0) console.log(`  ${unchanged} unchanged (skipped)`);
  if (toIndex.length === 0) {
    console.log(`  Nothing to index`);
    return 0;
  }

  console.log(`  Indexing ${toIndex.length} documents...`);

  // Delete existing rows for changed parents (and their chunks) + standalone changed files
  const changedParents = dirtyParents;
  const standaloneChanged = toIndex.filter((d) => !d.parentFile && !d.isParent).map((d) => d.filename);

  for (const parentFile of changedParents) {
    // Delete parent + all its chunks (LIKE 'parent::%' и сам parent)
    await sql`
      DELETE FROM public.knowledge_chunk
      WHERE source = ${source}
        AND account_id IS NOT DISTINCT FROM ${accountId}::uuid
        AND (source_uri = ${parentFile} OR source_uri LIKE ${parentFile + '::%'})
    `;
    console.log(`  Cleaned old parent + chunks for ${parentFile}`);
  }
  // Delete changed standalone files
  if (standaloneChanged.length > 0) {
    await sql`
      DELETE FROM public.knowledge_chunk
      WHERE source = ${source}
        AND account_id IS NOT DISTINCT FROM ${accountId}::uuid
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
        source, source_uri, source_kind, collection_kind, account_id,
        content, embedding, indexed_at
      )
      VALUES (
        ${chunkId}, ${parent.filename}, 0, ${parent.hash}, ${parent.hash},
        ${source}, ${parent.filename}, ${source_type}, ${collectionKind}, ${accountId}::uuid,
        ${parent.content}, NULL, NOW()
      )
      ON CONFLICT (source_uri, source, COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid))
      DO NOTHING
      RETURNING chunk_uuid
    ` as { chunk_uuid: string }[];
    if (result[0]) parentUuids.set(parent.filename, result[0].chunk_uuid);
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
          source, source_uri, source_kind, collection_kind, account_id,
          content, embedding, parent_chunk_id, indexed_at
        )
        VALUES (
          ${chunkId}, ${doc.filename}, ${pos}, ${doc.hash}, ${doc.hash},
          ${source}, ${doc.filename}, ${source_type}, ${collectionKind}, ${accountId}::uuid,
          ${doc.content}, ${embeddingStr}::vector, ${parentUuid}::uuid, NOW()
        )
        ON CONFLICT (source_uri, source, COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid))
        DO NOTHING
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

    const uidIdx = args.indexOf("--user-id");
    const userId: string | undefined = uidIdx !== -1 ? args[uidIdx + 1] : undefined;

    const config: SourceConfig = {
      source: args[sourceIdx + 1],
      source_type: args[typeIdx + 1] as "pack" | "guides" | "ds",
      path: args[pathIdx + 1],
      user_id: userId,
    };

    // Guard: block platform ingest when path is covered by a personal source config
    const personalConfigPath = join(__dirname, "sources-personal.json");
    if (!userId && existsSync(personalConfigPath)) {
      const home = process.env.HOME;
      if (!home) {
        console.error("⛔ HOME env var is not set — cannot resolve ~/paths for personal-source guard. Aborting.");
        process.exit(1);
      }
      const personalSources: SourceConfig[] = JSON.parse(readFileSync(personalConfigPath, "utf-8"));
      const normalize = (p: string) => (p.endsWith("/") ? p : p + "/");
      const resolvedPath = normalize(config.path.replace("~/", home + "/"));
      const covered = personalSources.find((s) => {
        const sPath = normalize(s.path.replace("~/", home + "/"));
        return resolvedPath.startsWith(sPath) || sPath.startsWith(resolvedPath);
      });
      if (covered) {
        console.error(`⛔ GUARD: "${config.path}" покрыт personal-источником "${covered.source}" (sources-personal.json).`);
        console.error(`   Добавь --user-id ${covered.user_id} чтобы индексировать как personal.`);
        console.error(`   Без --user-id данные будут записаны как platform (видны всем) — это ошибка для личного контента.`);
        process.exit(1);
      }
    }

    if (args.includes("--clean")) {
      const cleanAccountId: string | null = userId ?? null;
      const deleted = await sql`
        DELETE FROM public.knowledge_chunk
        WHERE source = ${config.source}
          AND account_id IS NOT DISTINCT FROM ${cleanAccountId}::uuid
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
