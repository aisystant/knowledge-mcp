#!/usr/bin/env npx tsx
/**
 * Fix: make concept_id nullable in misconceptions, then reload all 73 memes.
 * Also link memes to concepts via LLM embedding similarity.
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { neon } from "@neondatabase/serverless";

const __dirname = dirname(fileURLToPath(import.meta.url));
const vars = readFileSync(join(__dirname, "../.dev.vars"), "utf-8");
const env: Record<string, string> = {};
for (const line of vars.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.+)/);
  if (m) env[m[1]] = m[2].trim();
}

const sql = neon(env.DATABASE_URL.replace("-pooler", ""));
const IWE = join(process.env.HOME!, "IWE");

// 1. Make concept_id nullable
console.log("1. Making concept_id nullable...");
await sql`ALTER TABLE concept_graph.concept_misconceptions ALTER COLUMN concept_id DROP NOT NULL`;
console.log("  ✅ done");

// 2. Parse misconceptions from CAT.001
console.log("\n2. Parsing CAT.001 misconceptions...");
const dir = join(IWE, "DS-principles-curriculum/data/curriculum/CAT.001");
const files = readdirSync(dir).filter(f => f.endsWith(".md")).sort();

interface Meme {
  name: string;
  category: string;
  correct_version: string | null;
  source_file: string;
  area: string | null;
}

const memes: Meme[] = [];

for (const file of files) {
  const content = readFileSync(join(dir, file), "utf-8");

  // Parse frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) continue;
  const fm = fmMatch[1];

  const nameMatch = fm.match(/name:\s*"?(.+?)"?\s*$/m);
  const areaMatch = fm.match(/area:\s*(\d+)/);
  const name = nameMatch ? nameMatch[1].replace(/^["']|["']$/g, "") : file;

  // Extract correct version from body
  const body = content.slice(content.indexOf("---", 3) + 3);
  const antithesisMatch = body.match(/Продуктивный антитезис[:\s]*([^\n]+)/i);
  const correctVersion = antithesisMatch ? antithesisMatch[1].trim() : null;

  // Determine category
  let category = "wrong_application";
  if (body.includes("подмен") || body.includes("бытов")) category = "folk_substitution";
  else if (body.includes("неверн") || body.includes("ошибочн")) category = "wrong_concept";

  memes.push({
    name,
    category,
    correct_version: correctVersion,
    source_file: file,
    area: areaMatch ? areaMatch[1] : null,
  });
}

console.log(`  Found ${memes.length} misconceptions`);

// 3. Try to link each meme to closest concept via embedding
console.log("\n3. Embedding memes and linking to concepts...");

async function getEmbedding(text: string): Promise<number[]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input: [text], model: "text-embedding-3-small", dimensions: 1024 }),
  });
  const data = (await response.json()) as { data: { embedding: number[] }[] };
  return data.data[0].embedding;
}

let inserted = 0;
for (const meme of memes) {
  // Find closest concept via embedding
  const emb = await getEmbedding(meme.name);
  const vecStr = `[${emb.join(",")}]`;

  const closest = await sql`
    SELECT id, code, name, 1 - (embedding <=> ${vecStr}::vector) AS score
    FROM concept_graph.concepts
    WHERE status = 'active' AND level IN ('guide', 'pack')
    ORDER BY embedding <=> ${vecStr}::vector
    LIMIT 1
  `;

  const conceptId = closest.length > 0 && Number(closest[0].score) > 0.3 ? closest[0].id : null;
  const matchInfo = closest.length > 0 ? `→ ${closest[0].code} "${closest[0].name}" (${Number(closest[0].score).toFixed(3)})` : "→ no match";

  await sql`
    INSERT INTO concept_graph.concept_misconceptions
      (concept_id, category, misconception_text, correct_version, source_file)
    VALUES (${conceptId}, ${meme.category}, ${meme.name}, ${meme.correct_version}, ${meme.source_file})
  `;
  inserted++;

  if (inserted % 10 === 0 || inserted <= 5) {
    console.log(`  [${inserted}/${memes.length}] "${meme.name}" ${matchInfo}`);
  }
}

console.log(`\n  ✅ Inserted ${inserted} misconceptions`);

// 4. Verify
const [count] = await sql`SELECT COUNT(*)::int AS cnt FROM concept_graph.concept_misconceptions`;
const [linked] = await sql`SELECT COUNT(*)::int AS cnt FROM concept_graph.concept_misconceptions WHERE concept_id IS NOT NULL`;
console.log(`\nVerification: ${count.cnt} total, ${linked.cnt} linked to concepts`);
