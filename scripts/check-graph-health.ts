#!/usr/bin/env npx tsx
/**
 * Concept graph health check — WP-439 Ф6
 *
 * Checks EN translation coverage against the ratchet baseline in
 * concept_graph.coverage_baseline. Fails (exit 1) when coverage drops below
 * the stored baseline. On improvement, updates the baseline transactionally.
 *
 * Usage:
 *   npx tsx scripts/check-graph-health.ts            # check only
 *   npx tsx scripts/check-graph-health.ts --update   # check + update baseline on improvement
 *
 * Integrations:
 *   - CI: run on every push that touches knowledge-mcp or concept graph data.
 *   - Week Close extension: `bash DS-my-strategy/extensions/week-close.after.md`
 *     already calls this script (informational, not blocking in week-close context).
 *
 * WHY ratchet-in-DB: file-based `.coverage-baseline.json` causes merge conflicts
 * in parallel branches and is decoupled from DB state. A single-row DB table is
 * atomic and authoritative. Ref: peer-session 2026-06-26-06.
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { neon } from "@neondatabase/serverless";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv(): Record<string, string> {
  const devVarsPath = join(__dirname, "../.dev.vars");
  const env: Record<string, string> = {};
  if (existsSync(devVarsPath)) {
    for (const line of readFileSync(devVarsPath, "utf-8").split("\n")) {
      const m = line.match(/^(\w+)\s*=\s*(.+)$/);
      if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  // Process env takes precedence.
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}

interface Coverage {
  pctWithEn: number;
  totalActive: number;
  totalTranslatable: number;
  translatableWithEn: number;
}

type SqlClient = ReturnType<typeof neon>;

async function measureCoverage(sql: SqlClient, schema: string): Promise<Coverage> {
  const rows = await sql`
    SELECT
      ROUND(
        100.0 * COUNT(*) FILTER (WHERE name_en IS NOT NULL AND is_translatable = TRUE)
        / NULLIF(COUNT(*) FILTER (WHERE is_translatable = TRUE), 0),
        2
      ) AS pct_with_en,
      COUNT(*) FILTER (WHERE status = 'active')             AS total_active,
      COUNT(*) FILTER (WHERE status = 'active' AND is_translatable = TRUE) AS total_translatable,
      COUNT(*) FILTER (WHERE status = 'active' AND is_translatable = TRUE AND name_en IS NOT NULL)
                                                             AS translatable_with_en
    FROM ${sql.unsafe(schema)}.concepts
    WHERE status = 'active'
  `;
  const row = rows[0];
  return {
    pctWithEn: Number(row.pct_with_en) || 0,
    totalActive: Number(row.total_active) || 0,
    totalTranslatable: Number(row.total_translatable) || 0,
    translatableWithEn: Number(row.translatable_with_en) || 0,
  };
}

interface Baseline {
  pctWithEn: number;
  measuredAt: string;
}

async function readBaseline(sql: SqlClient, schema: string): Promise<Baseline | null> {
  const rows = await sql`
    SELECT pct_with_en, measured_at
    FROM ${sql.unsafe(schema)}.coverage_baseline
    WHERE id = 1
  `;
  if (rows.length === 0) return null;
  return {
    pctWithEn: Number(rows[0].pct_with_en),
    measuredAt: String(rows[0].measured_at),
  };
}

async function updateBaseline(sql: SqlClient, schema: string, cov: Coverage): Promise<void> {
  await sql`
    INSERT INTO ${sql.unsafe(schema)}.coverage_baseline
      (id, pct_with_en, total_active, total_translatable, translatable_with_en, updated_by)
    VALUES (1, ${cov.pctWithEn}, ${cov.totalActive}, ${cov.totalTranslatable}, ${cov.translatableWithEn}, 'ci')
    ON CONFLICT (id) DO UPDATE SET
      pct_with_en          = EXCLUDED.pct_with_en,
      total_active         = EXCLUDED.total_active,
      total_translatable   = EXCLUDED.total_translatable,
      translatable_with_en = EXCLUDED.translatable_with_en,
      measured_at          = NOW(),
      updated_by           = 'ci'
  `;
}

async function main() {
  const args = process.argv.slice(2);
  const doUpdate = args.includes("--update");

  const env = loadEnv();
  const dsn = env.KNOWLEDGE_DATABASE_URL || env.DATABASE_URL;
  if (!dsn) {
    console.error("[check-graph-health] KNOWLEDGE_DATABASE_URL not set");
    process.exit(2);
  }

  const schema = env.CONCEPT_GRAPH_DB_SCHEMA || "concept_graph";
  // One client for the entire script run — avoids opening multiple direct Neon connections.
  const sql = neon(dsn.replace("-pooler", ""));

  let cov: Coverage;
  let baseline: Baseline | null;

  try {
    [cov, baseline] = await Promise.all([
      measureCoverage(sql, schema),
      readBaseline(sql, schema),
    ]);
  } catch (err) {
    console.error("[check-graph-health] DB query failed:", err instanceof Error ? err.message : err);
    process.exit(2);
  }

  console.log(`[check-graph-health] Coverage: ${cov.pctWithEn}% (${cov.translatableWithEn}/${cov.totalTranslatable} translatable, ${cov.totalActive} total active)`);

  if (!baseline) {
    console.warn("[check-graph-health] No baseline row — seeding with current coverage.");
    if (doUpdate) await updateBaseline(sql, schema, cov);
    process.exit(0);
  }

  console.log(`[check-graph-health] Baseline: ${baseline.pctWithEn}% (set ${baseline.measuredAt})`);

  if (cov.pctWithEn < baseline.pctWithEn) {
    console.error(
      `[check-graph-health] FAIL: coverage dropped ${baseline.pctWithEn}% → ${cov.pctWithEn}%. ` +
      `Run apply-translations.py --bulk to recover, then re-run this check with --update.`
    );
    process.exit(1);
  }

  if (doUpdate && cov.pctWithEn > baseline.pctWithEn) {
    await updateBaseline(sql, schema, cov);
    console.log(`[check-graph-health] Baseline updated: ${baseline.pctWithEn}% → ${cov.pctWithEn}%`);
  } else if (cov.pctWithEn > baseline.pctWithEn) {
    console.log(`[check-graph-health] Coverage improved to ${cov.pctWithEn}% (baseline not updated; re-run with --update to ratchet)`);
  }

  console.log("[check-graph-health] PASS");
}

main().catch((err) => {
  console.error("[check-graph-health] Unexpected error:", err);
  process.exit(2);
});
