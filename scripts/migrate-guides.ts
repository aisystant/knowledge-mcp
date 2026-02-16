#!/usr/bin/env npx tsx
/**
 * Migrate guides data from SurrealDB (mcp/guides) to Neon PostgreSQL.
 *
 * Reads sections from the old guides database, generates new embeddings
 * via Cloudflare Workers AI, and inserts into Neon pgvector.
 *
 * Usage:
 *   npx tsx scripts/migrate-guides.ts
 *   npx tsx scripts/migrate-guides.ts --dry-run
 *
 * Environment variables (or .dev.vars file):
 *   DATABASE_URL — Neon PostgreSQL connection string (target)
 *   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN — for embeddings
 *   SURREAL_HOST — SurrealDB host (source, default: https://surrealdb.aisystant.com)
 *   GUIDES_NS, GUIDES_DB, GUIDES_USER, GUIDES_PASS — SurrealDB guides credentials
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { neon } from "@neondatabase/serverless";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Config ---

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const BATCH_SIZE = 10;
const SOURCE_NAME = "aisystant-guides";
const SOURCE_TYPE = "guides";

// --- SurrealDB (source) ---

async function surrealSignin(host: string, ns: string, db: string, user: string, pass: string): Promise<string> {
  const response = await fetch(`${host}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ id: 1, method: "signin", params: [{ user, pass, ns, db }] }),
  });
  if (!response.ok) throw new Error(`SurrealDB signin: ${response.status} ${await response.text()}`);
  const data = (await response.json()) as { result?: string; error?: { message: string } };
  if (data.error) throw new Error(`SurrealDB signin: ${data.error.message}`);
  return data.result!;
}

async function surrealQuery(host: string, ns: string, db: string, user: string, pass: string, query: string): Promise<unknown[]> {
  const token = await surrealSignin(host, ns, db, user, pass);
  const response = await fetch(`${host}/sql`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      Accept: "application/json",
      "surreal-ns": ns,
      "surreal-db": db,
      Authorization: `Bearer ${token}`,
    },
    body: query,
  });
  if (!response.ok) throw new Error(`SurrealDB query: ${response.status} ${await response.text()}`);
  return (await response.json()) as unknown[];
}

// --- Cloudflare Workers AI (REST API) ---

async function getEmbeddings(accountId: string, apiToken: string, texts: string[]): Promise<number[][]> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${EMBEDDING_MODEL}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: texts }),
    }
  );
  if (!response.ok) throw new Error(`Cloudflare AI error: ${response.status} ${await response.text()}`);
  const data = (await response.json()) as { result: { data: number[][] }; success: boolean };
  if (!data.success) throw new Error("Cloudflare AI: request failed");
  return data.result.data;
}

// --- Main ---

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  // Load env
  const env: Record<string, string> = {
    DATABASE_URL: process.env.DATABASE_URL || "",
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || "",
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || "",
    SURREAL_HOST: process.env.SURREAL_HOST || "https://surrealdb.aisystant.com",
    GUIDES_NS: process.env.GUIDES_NS || "mcp",
    GUIDES_DB: process.env.GUIDES_DB || "guides",
    GUIDES_USER: process.env.GUIDES_USER || "",
    GUIDES_PASS: process.env.GUIDES_PASS || "",
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
    console.error("Missing: DATABASE_URL, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN");
    process.exit(1);
  }
  if (!env.GUIDES_USER || !env.GUIDES_PASS) {
    console.error("Missing: GUIDES_USER, GUIDES_PASS (SurrealDB credentials for guides)");
    process.exit(1);
  }

  console.log("=== Guides Migration: SurrealDB → Neon ===");
  console.log(`Source: SurrealDB ns=${env.GUIDES_NS} db=${env.GUIDES_DB}`);
  console.log(`Target: Neon PostgreSQL`);
  if (dryRun) console.log("DRY RUN");

  // Step 1: Read sections from guides DB
  console.log("\n[1] Reading sections from guides DB...");
  let sections: { slug: string; title: string; content: string; guide_id?: string; lang?: string }[];
  try {
    const result = await surrealQuery(
      env.SURREAL_HOST, env.GUIDES_NS, env.GUIDES_DB,
      env.GUIDES_USER, env.GUIDES_PASS,
      "SELECT slug, title, content, guide_id, lang FROM sections ORDER BY guide_id, order"
    );
    const rows = (result[0] as any)?.result;
    sections = Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.error(`Failed to read guides DB: ${err}`);
    process.exit(1);
  }

  console.log(`  Found ${sections.length} sections`);
  const valid = sections.filter((s) => s.content && s.content.trim().length >= 10);
  console.log(`  ${valid.length} with content`);

  if (valid.length === 0) return;

  // Guides breakdown
  const guideCounts = new Map<string, number>();
  for (const s of valid) {
    const g = s.guide_id || "unknown";
    guideCounts.set(g, (guideCounts.get(g) || 0) + 1);
  }
  for (const [g, c] of guideCounts) console.log(`    ${g}: ${c}`);

  if (dryRun) {
    console.log("\nDRY RUN complete.");
    return;
  }

  const sql = neon(env.DATABASE_URL);

  // Step 2: Check existing
  console.log("\n[2] Checking existing...");
  const existingRows = await sql`
    SELECT filename, hash FROM documents WHERE source_type = ${SOURCE_TYPE}
  `;
  const existingHashes = new Map<string, string>();
  for (const row of existingRows) {
    existingHashes.set(row.filename as string, row.hash as string);
  }
  console.log(`  ${existingHashes.size} existing`);

  // Step 3: Prepare documents
  const documents = valid.map((s) => {
    const guideSlug = s.guide_id?.replace(/^guides:/, "") || "unknown";
    return {
      filename: `${guideSlug}/${s.slug}.md`,
      content: s.content,
      hash: contentHash(s.content),
    };
  });

  const toIndex = documents.filter((d) => existingHashes.get(d.filename) !== d.hash);
  if (toIndex.length === 0) {
    console.log("  All up to date.");
    return;
  }

  console.log(`\n[3] Indexing ${toIndex.length} documents...`);

  let indexed = 0;
  for (let i = 0; i < toIndex.length; i += BATCH_SIZE) {
    const batch = toIndex.slice(i, i + BATCH_SIZE);
    const texts = batch.map((d) => d.content.slice(0, 8000));
    const embeddings = await getEmbeddings(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN, texts);

    for (let j = 0; j < batch.length; j++) {
      const doc = batch[j];
      const embeddingStr = `[${embeddings[j].join(",")}]`;

      await sql`
        INSERT INTO documents (filename, content, source, source_type, hash, embedding, search_vector)
        VALUES (${doc.filename}, ${doc.content}, ${SOURCE_NAME}, ${SOURCE_TYPE}, ${doc.hash}, ${embeddingStr}::vector, to_tsvector('simple', ${doc.content}))
        ON CONFLICT (filename, source)
        DO UPDATE SET content = ${doc.content}, source_type = ${SOURCE_TYPE}, hash = ${doc.hash}, embedding = ${embeddingStr}::vector, search_vector = to_tsvector('simple', ${doc.content})
      `;
    }

    indexed += batch.length;
    console.log(`  ${indexed}/${toIndex.length}`);

    if (i + BATCH_SIZE < toIndex.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  console.log(`\nDone. Migrated ${indexed} guides.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
