#!/usr/bin/env npx tsx
/**
 * Migrate guides data from SurrealDB (mcp/guides) to unified knowledge DB.
 *
 * Reads sections from the guides database, re-embeds with text-embedding-3-large,
 * and inserts as documents into the knowledge database with source_type="guides".
 *
 * Usage:
 *   npx tsx scripts/migrate-guides.ts
 *   npx tsx scripts/migrate-guides.ts --dry-run  # preview without writing
 *
 * Environment variables (or .dev.vars file):
 *   SURREAL_HOST, SURREAL_USER, SURREAL_PASSWORD, OPENAI_API_KEY
 *   GUIDES_NS (default: "mcp"), GUIDES_DB (default: "guides")
 *   GUIDES_USER (default: SURREAL_USER), GUIDES_PASS (default: SURREAL_PASSWORD)
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

// --- Config ---

const EMBEDDING_MODEL = "text-embedding-3-large";
const TABLE_NAME = "documents";
const TARGET_DB = "knowledge";
const BATCH_SIZE = 10;
const SOURCE_NAME = "aisystant-guides";
const SOURCE_TYPE = "guides";

// --- Types ---

interface GuideSection {
  id?: string;
  slug: string;
  title: string;
  content: string;
  url?: string;
  guide_id?: string;
  lang?: string;
  order?: number;
}

// --- SurrealDB helpers ---

async function surrealSigninRpc(
  host: string,
  ns: string,
  db: string,
  user: string,
  pass: string
): Promise<string> {
  const response = await fetch(`${host}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      id: 1,
      method: "signin",
      params: [{ user, pass, ns, db }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SurrealDB RPC signin: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { result?: string; error?: { message: string } };
  if (data.error) throw new Error(`SurrealDB signin: ${data.error.message}`);
  return data.result!;
}

async function surrealQueryRpc(
  host: string,
  ns: string,
  db: string,
  user: string,
  pass: string,
  query: string
): Promise<unknown[]> {
  const token = await surrealSigninRpc(host, ns, db, user, pass);

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

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SurrealDB query: ${response.status} ${text}`);
  }

  return (await response.json()) as unknown[];
}

async function surrealSigninRest(host: string, ns: string, user: string, password: string): Promise<string> {
  const response = await fetch(`${host}/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ns, user, pass: password }),
  });
  if (!response.ok) throw new Error(`SurrealDB signin: ${response.status} ${await response.text()}`);
  const data = (await response.json()) as { token: string };
  return data.token;
}

async function surrealExec(host: string, ns: string, db: string, user: string, password: string, query: string): Promise<unknown[]> {
  const token = await surrealSigninRest(host, ns, user, password);
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

// --- Main ---

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  // Load env from .dev.vars
  const env: Record<string, string> = {
    SURREAL_HOST: process.env.SURREAL_HOST || "https://surrealdb.aisystant.com",
    SURREAL_USER: process.env.SURREAL_USER || "",
    SURREAL_PASSWORD: process.env.SURREAL_PASSWORD || "",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
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

  // Fallback: use main credentials for guides if not specified
  if (!env.GUIDES_USER) env.GUIDES_USER = env.SURREAL_USER;
  if (!env.GUIDES_PASS) env.GUIDES_PASS = env.SURREAL_PASSWORD;

  if (!env.SURREAL_USER || !env.SURREAL_PASSWORD || !env.OPENAI_API_KEY) {
    console.error("Missing env vars: SURREAL_USER, SURREAL_PASSWORD, OPENAI_API_KEY");
    console.error("Set them in environment or in .dev.vars file");
    process.exit(1);
  }

  console.log(`=== Guides → Knowledge Migration ===`);
  console.log(`Source: SurrealDB ns=${env.GUIDES_NS} db=${env.GUIDES_DB}`);
  console.log(`Target: SurrealDB ns=${env.SURREAL_USER} db=${TARGET_DB}`);
  console.log(`Embedding: ${EMBEDDING_MODEL}`);
  if (dryRun) console.log("DRY RUN — no writes will be made");

  // Step 1: Read all sections from guides DB
  console.log("\n[1] Reading sections from guides DB...");

  let sections: GuideSection[];
  try {
    const result = await surrealQueryRpc(
      env.SURREAL_HOST,
      env.GUIDES_NS,
      env.GUIDES_DB,
      env.GUIDES_USER,
      env.GUIDES_PASS,
      "SELECT slug, title, content, url, guide_id, lang, order FROM sections ORDER BY guide_id, order"
    );
    const rows = (result[0] as any)?.result;
    sections = Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.error(`Failed to read from guides DB: ${err}`);
    console.error("Check GUIDES_NS, GUIDES_DB, GUIDES_USER, GUIDES_PASS");
    process.exit(1);
  }

  console.log(`  Found ${sections.length} sections`);
  if (sections.length === 0) {
    console.log("  Nothing to migrate");
    return;
  }

  // Filter: only non-empty sections with content
  const validSections = sections.filter((s) => s.content && s.content.trim().length >= 10);
  console.log(`  ${validSections.length} sections with content (≥10 chars)`);

  // Show preview
  const guideCounts = new Map<string, number>();
  for (const s of validSections) {
    const guide = s.guide_id || "unknown";
    guideCounts.set(guide, (guideCounts.get(guide) || 0) + 1);
  }
  console.log(`  Guides breakdown:`);
  for (const [guide, count] of guideCounts) {
    console.log(`    ${guide}: ${count} sections`);
  }

  if (dryRun) {
    console.log("\nDRY RUN complete. Run without --dry-run to execute migration.");
    return;
  }

  // Step 2: Check existing documents in knowledge DB
  console.log("\n[2] Checking existing guides in knowledge DB...");
  const existingResult = await surrealExec(
    env.SURREAL_HOST,
    env.SURREAL_USER,
    TARGET_DB,
    env.SURREAL_USER,
    env.SURREAL_PASSWORD,
    `SELECT filename, hash FROM ${TABLE_NAME} WHERE source_type = '${SOURCE_TYPE}'`
  );
  const existingHashes = new Map<string, string>();
  const existingRows = (existingResult[0] as any)?.result;
  if (Array.isArray(existingRows)) {
    for (const row of existingRows) {
      existingHashes.set(row.filename, row.hash);
    }
  }
  console.log(`  ${existingHashes.size} existing guide documents in knowledge DB`);

  // Step 3: Prepare documents
  const documents = validSections.map((s) => {
    // Build filename from guide_id + slug
    const guideSlug = s.guide_id?.replace(/^guides:/, "") || "unknown";
    const filename = `${guideSlug}/${s.slug}.md`;

    return {
      filename,
      content: s.content,
      hash: contentHash(s.content),
      title: s.title,
      lang: s.lang || "ru",
    };
  });

  // Filter unchanged
  const toIndex = documents.filter((d) => existingHashes.get(d.filename) !== d.hash);
  const unchanged = documents.length - toIndex.length;
  if (unchanged > 0) console.log(`  ${unchanged} unchanged (skipped)`);
  if (toIndex.length === 0) {
    console.log("  All guides already migrated. Nothing to do.");
    return;
  }

  console.log(`\n[3] Indexing ${toIndex.length} documents...`);

  // Step 4: Embed and insert
  let indexed = 0;
  for (let i = 0; i < toIndex.length; i += BATCH_SIZE) {
    const batch = toIndex.slice(i, i + BATCH_SIZE);
    const texts = batch.map((d) => d.content.slice(0, 8000));

    const embeddings = await getEmbeddings(env.OPENAI_API_KEY, texts);

    for (let j = 0; j < batch.length; j++) {
      const doc = batch[j];
      const embedding = embeddings[j];
      const escapedFilename = doc.filename.replace(/'/g, "\\'");
      const escapedContent = doc.content.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const embeddingStr = `[${embedding.join(",")}]`;

      const query = `
        DELETE FROM ${TABLE_NAME} WHERE filename = '${escapedFilename}' AND source = '${SOURCE_NAME}';
        CREATE ${TABLE_NAME} SET
          filename = '${escapedFilename}',
          content = '${escapedContent}',
          source = '${SOURCE_NAME}',
          source_type = '${SOURCE_TYPE}',
          hash = '${doc.hash}',
          embedding = ${embeddingStr};
      `;

      await surrealExec(
        env.SURREAL_HOST,
        env.SURREAL_USER,
        TARGET_DB,
        env.SURREAL_USER,
        env.SURREAL_PASSWORD,
        query
      );
    }

    indexed += batch.length;
    console.log(`  ${indexed}/${toIndex.length} indexed`);

    if (i + BATCH_SIZE < toIndex.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log(`\nDone. Migrated ${indexed} guide sections to knowledge DB.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
