#!/usr/bin/env npx tsx
/**
 * Test LLM-based misconception detection (Ф4)
 */

import { readFileSync } from "fs";
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

const dbUrl = env.DATABASE_URL.replace("-pooler", "");
const sql = neon(dbUrl);

// Test text WITH memes
const testText = `Для развития нужна сила воли и самодисциплина.
Я уже знаю эту тему, теория бесполезна — нужна только практика.
Мой опыт говорит об обратном, я сам разберусь без учебников.
Главное — прочитать книгу, и знания сами усвоятся.
Нужно просто быть продуктивным и не тратить время зря.`;

console.log("=== Test: LLM Misconception Detection (Ф4) ===\n");
console.log(`Text: "${testText.slice(0, 80)}..."\n`);

// 1. Get all misconceptions
const misconceptions = await sql`
  SELECT cm.id, cm.misconception_text, cm.correct_version, cm.category, cm.folk_term, c.name AS concept_name
  FROM concept_graph.concept_misconceptions cm
  JOIN concept_graph.concepts c ON c.id = cm.concept_id
  LIMIT 30
`;

console.log(`Misconceptions in scope: ${misconceptions.length}\n`);

// 2. Build catalog
const miscCatalog = misconceptions.map((m, i) =>
  `[${i}] Мем: ${m.misconception_text} | Понятие: ${m.concept_name} | Тип: ${m.category}${m.correct_version ? ` | Правильно: ${m.correct_version}` : ""}`
).join("\n");

console.log("Catalog (first 5):");
for (const line of miscCatalog.split("\n").slice(0, 5)) {
  console.log(`  ${line}`);
}

// 3. Call LLM
console.log("\nCalling GPT-4o-mini...");

const llmPrompt = `Ты — эксперт по выявлению подмен понятий (мемов) в текстах учеников.

Текст ученика:
"""
${testText}
"""

Каталог известных мемов (подмен понятий):
${miscCatalog}

Задача: определи, какие мемы из каталога проявляются в тексте ученика.

Мем проявляется если:
- Ученик использует бытовую подмену вместо правильного термина (folk_substitution)
- Ученик применяет понятие неправильно (wrong_application)
- Ученик путает одно понятие с другим (wrong_concept)

Ответь СТРОГО в JSON формате — массив номеров мемов из каталога:
{"found": [0, 3, 7], "explanations": ["краткое пояснение для каждого найденного"]}

Если мемов не обнаружено: {"found": [], "explanations": []}`;

const response = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: llmPrompt }],
    temperature: 0.1,
    max_tokens: 500,
    response_format: { type: "json_object" },
  }),
});

if (!response.ok) {
  console.log(`  ❌ LLM error: ${response.status}`);
  process.exit(1);
}

const data = (await response.json()) as { choices: { message: { content: string } }[] };
const content = data.choices[0]?.message?.content || "{}";
console.log(`\nLLM response: ${content}\n`);

const parsed = JSON.parse(content) as { found: number[]; explanations: string[] };

console.log(`Found ${parsed.found.length} misconceptions:\n`);
for (let i = 0; i < parsed.found.length; i++) {
  const idx = parsed.found[i];
  const m = misconceptions[idx];
  if (m) {
    console.log(`  ⚠️ [${m.category}] ${m.misconception_text}`);
    if (m.correct_version) console.log(`     ✅ Правильно: ${m.correct_version}`);
    console.log(`     💬 ${parsed.explanations[i]}`);
    console.log();
  }
}

console.log("=== Done ===");
