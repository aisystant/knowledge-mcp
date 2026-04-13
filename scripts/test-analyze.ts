#!/usr/bin/env npx tsx
/**
 * Local test for analyze_verbalization — calls the function directly (not via MCP).
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { neon } from "@neondatabase/serverless";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .dev.vars
const devVarsPath = join(__dirname, "../.dev.vars");
const vars = readFileSync(devVarsPath, "utf-8");
const env: Record<string, string> = {};
for (const line of vars.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.+)/);
  if (m) env[m[1]] = m[2].trim();
}

const dbUrl = env.DATABASE_URL.replace("-pooler", "");
const sql = neon(dbUrl);

// --- Inline getEmbedding ---
async function getEmbedding(text: string): Promise<number[]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: [text],
      model: "text-embedding-3-small",
      dimensions: 1024,
    }),
  });
  const data = (await response.json()) as { data: { embedding: number[] }[] };
  return data.data[0].embedding;
}

// --- Test ---

const testText = `Роль — это то, что человек делает на работе.
Для развития мастерства нужна постоянная практика и осознанное усилие.
Важно выбрать правильный метод и следовать ему. Деятельность должна быть осмысленной.
Сила воли помогает преодолевать трудности.`;

const topic = "Роли и мастерство";

console.log("=== Test: analyze_verbalization ===\n");
console.log(`Topic: "${topic}"`);
console.log(`Text: "${testText.slice(0, 100)}..."\n`);

// 1. Get topic concepts
console.log("1. Finding topic concepts...");
const topicEmbedding = await getEmbedding(topic);
const vecStr = `[${topicEmbedding.join(",")}]`;

const topicConcepts = await sql`
  SELECT id, code, name, level, domain,
         1 - (embedding <=> ${vecStr}::vector) AS similarity
  FROM concept_graph.concepts
  WHERE status = 'active'
  ORDER BY embedding <=> ${vecStr}::vector
  LIMIT 30
`;

console.log(`  Found ${topicConcepts.length} concepts:`);
for (const c of topicConcepts.slice(0, 15)) {
  console.log(`    ${c.code} | ${c.name} | ${c.level} | sim=${Number(c.similarity).toFixed(3)}`);
}

// 2. Match concepts via LLM
console.log("\n2. Matching concepts via LLM-as-judge...");

const conceptList = topicConcepts.map((c: any, i: number) => `[${i}] ${c.name}`).join("\n");
const matchPrompt = `Определи, какие понятия из списка реально использованы или объяснены в тексте ученика.

Текст:
"""
${testText}
"""

Понятия:
${conceptList}

Правила:
- Понятие "использовано" если ученик упоминает его (в любой форме слова) ИЛИ объясняет его суть своими словами
- НЕ считай понятие использованным если упомянуто только одно общеупотребительное слово из составного термина (например, "роль" в бытовом смысле ≠ "проектная роль")
- Будь строгим: лучше пропустить, чем ложно засчитать

Ответь JSON: {"found": [0, 3, 7], "confidence": [0.9, 0.7, 0.8]}`;

const llmResp = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: matchPrompt }],
    temperature: 0.1, max_tokens: 300,
    response_format: { type: "json_object" },
  }),
});

const llmData = (await llmResp.json()) as { choices: { message: { content: string } }[] };
const parsed = JSON.parse(llmData.choices[0]?.message?.content || "{}") as { found: number[]; confidence: number[] };

console.log(`\n  LLM found ${parsed.found.length} concepts:\n`);
for (let i = 0; i < parsed.found.length; i++) {
  const idx = parsed.found[i];
  const c = topicConcepts[idx];
  if (c) console.log(`  ✅ ${c.name} (confidence=${parsed.confidence[i]})`);
}

const missedCount = topicConcepts.length - parsed.found.length;
console.log(`\n  Coverage: ${parsed.found.length}/${topicConcepts.length} (${Math.round(parsed.found.length/topicConcepts.length*100)}%)`);
console.log(`  Missed: ${missedCount}`);

// 3. Check misconceptions
console.log("\n3. Checking misconceptions...");
const conceptIds = topicConcepts.map((c) => c.id);
const misconceptions = await sql`
  SELECT cm.misconception_text, cm.correct_version, cm.category
  FROM concept_graph.concept_misconceptions cm
  WHERE cm.concept_id = ANY(${conceptIds})
`;
console.log(`  ${misconceptions.length} misconceptions in scope`);

// 4. Graph stats
console.log("\n4. Quick graph stats...");
const [stats] = await sql`SELECT COUNT(*)::int AS cnt FROM concept_graph.concepts WHERE status = 'active'`;
const [edges] = await sql`SELECT COUNT(*)::int AS cnt FROM concept_graph.concept_edges`;
console.log(`  Concepts: ${stats.cnt}, Edges: ${edges.cnt}`);

console.log("\n=== Done ===");
