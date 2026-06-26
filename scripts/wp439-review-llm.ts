#!/usr/bin/env npx tsx
/**
 * WP-439 Ф3 follow-up: acceptance sampling for LLM-translated concepts.
 *
 * Fetches N random pending LLM translations, evaluates quality via Sonnet
 * (OpenRouter), and bulk-accepts all pending if acceptance rate >= threshold.
 * On rejection path: exports the sampled rows to CSV for pilot review.
 *
 * Usage:
 *   npx tsx scripts/wp439-review-llm.ts [--threshold=0.9] [--sample=30]
 *   npx tsx scripts/wp439-review-llm.ts --dry-run   # show sample, no LLM calls
 *
 * Env: KNOWLEDGE_DATABASE_URL (or DATABASE_URL), OPENROUTER_API_KEY
 * Ref: peer-session 2026-06-26-15.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { neon } from "@neondatabase/serverless";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadDevVars(): Record<string, string> {
  const path = join(__dirname, "../.dev.vars");
  if (!existsSync(path)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

interface SampledRow {
  code: string;
  name_ru: string;
  name_en: string;
  definition: string | null;
  parent_kind: string | null;
}

interface ReviewResult extends SampledRow {
  verdict: "ACCEPT" | "REJECT";
  reason: string;
}

async function evaluateTranslation(
  row: SampledRow,
  apiKey: string,
): Promise<{ verdict: "ACCEPT" | "REJECT"; reason: string }> {
  const contextLines = [
    row.definition ? `Definition: ${row.definition}` : null,
    row.parent_kind ? `This is a kind of: ${row.parent_kind}` : null,
  ].filter(Boolean);

  const prompt =
    `You are reviewing Russian→English translations for a systems engineering methodology knowledge graph.\n` +
    `Evaluate whether the English name is correct and natural for this concept.\n\n` +
    `Russian: ${row.name_ru}\n` +
    `English: ${row.name_en}\n` +
    (contextLines.length ? contextLines.join("\n") + "\n" : "") +
    `\nReply with exactly one line: ACCEPT or REJECT, colon, brief reason (≤10 words).\n` +
    `Example: ACCEPT: accurate translation of the systems engineering term\n` +
    `Example: REJECT: transliteration instead of translation`;

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4-6",
      max_tokens: 60,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenRouter ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = (await resp.json()) as { choices: { message: { content: string } }[] };
  const raw = data.choices[0]?.message?.content?.trim() ?? "";
  const m = raw.match(/^(ACCEPT|REJECT):\s*(.+)$/i);
  if (!m) {
    return { verdict: "REJECT", reason: `unexpected format: ${raw.slice(0, 50)}` };
  }
  return {
    verdict: m[1].toUpperCase() as "ACCEPT" | "REJECT",
    reason: m[2].trim(),
  };
}

function writeCsv(rows: ReviewResult[], path: string): void {
  const header = "code,name_ru,name_en,parent_kind,definition,verdict,reason\n";
  const lines = rows.map((r) =>
    [r.code, r.name_ru, r.name_en, r.parent_kind ?? "", r.definition ?? "", r.verdict, r.reason]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(","),
  );
  writeFileSync(path, header + lines.join("\n") + "\n", "utf-8");
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const threshold = Number(args.find((a) => a.startsWith("--threshold="))?.split("=")[1] ?? "0.9");
  const sampleSize = Number(args.find((a) => a.startsWith("--sample="))?.split("=")[1] ?? "30");

  const vars = loadDevVars();
  const dsn =
    process.env.KNOWLEDGE_DATABASE_URL ??
    vars.KNOWLEDGE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    vars.DATABASE_URL;
  const apiKey = process.env.OPENROUTER_API_KEY ?? vars.OPENROUTER_API_KEY;

  if (!dsn) { console.error("[review] KNOWLEDGE_DATABASE_URL not found"); process.exit(1); }
  if (!dryRun && !apiKey) { console.error("[review] OPENROUTER_API_KEY not found"); process.exit(1); }

  const sql = neon(dsn.replace("-pooler", ""));

  const countRows = await sql`
    SELECT count(*) AS total
    FROM concept_graph.concepts
    WHERE name_en_source = 'llm' AND name_en_status = 'pending'
  `;
  const totalPending = Number(countRows[0].total);
  console.log(`[review] Total llm+pending: ${totalPending}`);

  if (totalPending === 0) {
    console.log("[review] Nothing to review."); process.exit(0);
  }

  const rows = await sql`
    SELECT
      c.code,
      COALESCE(c.name_ru, c.name)  AS name_ru,
      c.name_en,
      LEFT(c.definition, 300)      AS definition,
      kc.parent_name_en            AS parent_kind
    FROM concept_graph.concepts c
    LEFT JOIN concept_graph.concept_kind_context kc ON kc.child_id = c.id
    WHERE c.name_en_source = 'llm'
      AND c.name_en_status = 'pending'
    ORDER BY random()
    LIMIT ${sampleSize}
  `;

  const sample: SampledRow[] = rows.map((r) => ({
    code: String(r.code),
    name_ru: String(r.name_ru),
    name_en: String(r.name_en),
    definition: r.definition != null ? String(r.definition) : null,
    parent_kind: r.parent_kind != null ? String(r.parent_kind) : null,
  }));

  console.log(`[review] Sampled ${sample.length} rows`);

  if (dryRun) {
    console.log("[review] --dry-run, first 5 rows:");
    sample.slice(0, 5).forEach((r) =>
      console.log(`  ${r.code}: "${r.name_ru}" → "${r.name_en}" (kind: ${r.parent_kind ?? "—"})`),
    );
    process.exit(0);
  }

  const results: ReviewResult[] = [];
  for (let i = 0; i < sample.length; i++) {
    const row = sample[i];
    process.stdout.write(`  [${i + 1}/${sample.length}] ${row.code}: "${row.name_en}" ... `);
    try {
      const { verdict, reason } = await evaluateTranslation(row, apiKey!);
      console.log(`${verdict} — ${reason}`);
      results.push({ ...row, verdict, reason });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`ERROR — ${msg}`);
      results.push({ ...row, verdict: "REJECT", reason: `api error: ${msg.slice(0, 60)}` });
    }
  }

  const accepted = results.filter((r) => r.verdict === "ACCEPT").length;
  const rate = accepted / results.length;
  console.log(`\n[review] Acceptance: ${accepted}/${results.length} = ${(rate * 100).toFixed(1)}%`);

  if (rate >= threshold) {
    console.log(`[review] >= ${(threshold * 100).toFixed(0)}% — bulk-accepting all ${totalPending} llm+pending`);
    await sql`
      UPDATE concept_graph.concepts
      SET name_en_status = 'ok'
      WHERE name_en_source = 'llm' AND name_en_status = 'pending'
    `;
    console.log(`[review] Done. ${totalPending} rows set to status='ok'`);
  } else {
    const csvPath = join(__dirname, "../wp439-review-rejected-sample.csv");
    writeCsv(results, csvPath);
    console.log(`[review] < ${(threshold * 100).toFixed(0)}% — see ${csvPath}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[review] Fatal:", err instanceof Error ? err.message : err);
  process.exit(2);
});
