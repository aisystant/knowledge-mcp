#!/usr/bin/env npx tsx
/**
 * WP-439 Ф1 — apply the glossary anchor to the concept graph.
 *
 * Two steps, idempotent:
 *   1. Apply migration 017 (name_en_source / name_en_status columns + backfill)
 *      if not already applied. DDL uses IF NOT EXISTS; backfill guards on
 *      name_en_source IS NULL — re-running is a no-op.
 *   2. Read RP-415's glossary-v0.1.csv (the anchor source-of-truth) and stamp
 *      matching concepts with name_en + name_en_source='glossary'.
 *
 * Anchor precedence (glossary beats unaudited, never overwrites canonical):
 *   - source IN ('fpf','manual','inherited') -> protected: never re-stamp;
 *                                               log only if glossary disagrees
 *   - name_en NULL                           -> set from glossary ('glossary')
 *   - source IN ('unknown','llm')            -> overwrite to 'glossary' (the audit)
 *   - source 'glossary', same value          -> confirm (idempotent no-op)
 *   - source 'glossary', different value      -> re-apply (csv changed)
 *
 * Match key: COALESCE(name_ru, name) = term_ru (name is always present; name_ru
 * is the canonical Russian name once WP-242 Ф-B has filled it).
 *
 * Usage:
 *   npx tsx scripts/wp439-apply-anchor.ts --dry-run     # plan only, no writes
 *   npx tsx scripts/wp439-apply-anchor.ts               # apply
 *   npx tsx scripts/wp439-apply-anchor.ts --glossary <path>
 *
 * One-shot script (WP-439 Ф1), not for production runtime. Ф5 will decide how
 * the anchor reaches the prod ingest path (bundled snapshot vs snapshot table).
 */

import { readFileSync, existsSync } from "fs";
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

/** Minimal CSV line parser with quoted-field support (no csv lib in deps). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQ = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

interface AnchorEntry {
  termRu: string;
  termEn: string;
}

function loadGlossary(path: string): AnchorEntry[] {
  const text = readFileSync(path, "utf-8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const ruIdx = header.indexOf("term_ru");
  const enIdx = header.indexOf("term_en");
  if (ruIdx === -1 || enIdx === -1) {
    throw new Error(`glossary header missing term_ru/term_en: ${header.join(",")}`);
  }
  const entries: AnchorEntry[] = [];
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const termRu = (cols[ruIdx] ?? "").trim();
    const termEn = (cols[enIdx] ?? "").trim();
    if (termRu && termEn) entries.push({ termRu, termEn });
  }
  return entries;
}

const MIGRATION_FILE = "017-concept-en-provenance.sql";

/** Split a .sql file into executable statements (strip comments, BEGIN/COMMIT). */
function migrationStatements(sqlPath: string): string[] {
  const raw = readFileSync(sqlPath, "utf-8");
  const noComments = raw.replace(/--[^\n]*/g, "");
  return noComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => !/^(begin|commit)$/i.test(s));
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const glossaryArg = process.argv.indexOf("--glossary");
  const glossaryPath =
    glossaryArg !== -1 && process.argv[glossaryArg + 1]
      ? process.argv[glossaryArg + 1]
      : join(__dirname, "../../../iwe-translation-engine/glossary/glossary-v0.1.csv");

  if (!existsSync(glossaryPath)) {
    console.error(`Glossary not found: ${glossaryPath}`);
    process.exit(1);
  }

  const vars = loadDevVars();
  const rawUrl =
    process.env.KNOWLEDGE_DATABASE_URL ??
    vars.KNOWLEDGE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    vars.DATABASE_URL ??
    "";
  if (!rawUrl) {
    console.error("KNOWLEDGE_DATABASE_URL or DATABASE_URL not found");
    process.exit(1);
  }
  const sql = neon(rawUrl.replace("-pooler", ""));

  const glossary = loadGlossary(glossaryPath);
  console.log(`Glossary: ${glossary.length} terms from ${glossaryPath}`);

  // Step 1: migration 017 (idempotent).
  const migrationPath = join(__dirname, "../migrations", MIGRATION_FILE);
  const statements = migrationStatements(migrationPath);
  if (dryRun) {
    console.log(`\n[dry-run] would apply migration ${MIGRATION_FILE} (${statements.length} statements)`);
  } else {
    await sql.transaction(statements.map((s) => sql.query(s)));
    console.log(`Applied migration ${MIGRATION_FILE} (${statements.length} statements)`);
  }

  // Step 2: load concepts into a match map (COALESCE(name_ru, name) -> rows).
  // In dry-run the migration is NOT applied, so name_en_source may not exist yet.
  // When the column is absent, emulate the post-backfill state via CASE (same rule
  // as migration 017: U.* -> 'fpf', other non-null name_en -> 'unknown') so the
  // plan reflects what running for real would produce — without writing anything.
  const colCheck = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'concept_graph'
      AND table_name = 'concepts'
      AND column_name = 'name_en_source'
  `;
  const hasProvenance = colCheck.length > 0;
  const concepts = (hasProvenance
    ? await sql`
        SELECT id, code, name, name_ru, name_en, name_en_source
        FROM concept_graph.concepts
        WHERE status = 'active'`
    : await sql`
        SELECT id, code, name, name_ru, name_en,
          CASE
            WHEN code LIKE 'U.%' AND name_en IS NOT NULL THEN 'fpf'
            WHEN name_en IS NOT NULL THEN 'unknown'
            ELSE NULL
          END AS name_en_source
        FROM concept_graph.concepts
        WHERE status = 'active'`) as Array<{
    id: number;
    code: string;
    name: string | null;
    name_ru: string | null;
    name_en: string | null;
    name_en_source: string | null;
  }>;

  // Provenance distribution (diagnostic — shows current state before planning).
  const dist = new Map<string, number>();
  for (const c of concepts) {
    const key = c.name_en === null ? "(no name_en)" : c.name_en_source ?? "(no source)";
    dist.set(key, (dist.get(key) ?? 0) + 1);
  }
  console.log("\n=== name_en provenance distribution ===");
  for (const [key, n] of [...dist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key}: ${n}`);
  }

  const byKey = new Map<string, typeof concepts>();
  for (const c of concepts) {
    const key = (c.name_ru ?? c.name ?? "").trim();
    if (!key) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(c);
    else byKey.set(key, [c]);
  }

  const toSet: number[] = []; // name_en NULL -> set
  const toOverwrite: number[] = []; // unknown/llm -> glossary (the audit)
  const toConfirm: number[] = []; // already == term -> stamp 'glossary'
  const conflicts: Array<{ code: string; current: string; glossary: string; source: string }> = [];
  let unmatched = 0;

  // Canonical/intentional sources (fpf, manual, inherited) are checked FIRST and
  // never re-stamped — only logged on disagreement. Without this guard, U.Method
  // / U.Role (source='fpf', name_en already 'Method'/'Role') match a glossary
  // term and get re-stamped 'glossary', clobbering FPF provenance
  // (cold-review 2026-06-25-08, Critical).
  for (const entry of glossary) {
    const rows = byKey.get(entry.termRu);
    if (!rows || rows.length === 0) {
      unmatched++;
      continue;
    }
    for (const c of rows) {
      const src = c.name_en_source;
      if (src === "fpf" || src === "manual" || src === "inherited") {
        if (c.name_en !== entry.termEn) {
          conflicts.push({
            code: c.code,
            current: c.name_en ?? "(null)",
            glossary: entry.termEn,
            source: src,
          });
        }
        // value equal -> leave untouched, keep canonical provenance
      } else if (c.name_en === null) {
        toSet.push(c.id);
      } else if (src === "unknown" || src === "llm") {
        if (c.name_en === entry.termEn) toConfirm.push(c.id);
        else toOverwrite.push(c.id);
      } else if (c.name_en === entry.termEn) {
        // already 'glossary' (or null source) with same value -> idempotent confirm
        toConfirm.push(c.id);
      } else {
        // 'glossary' with a changed value (csv updated) -> re-apply
        toOverwrite.push(c.id);
      }
    }
  }

  // Build id -> term_en lookup for the write step.
  const idToEn = new Map<number, string>();
  for (const entry of glossary) {
    const rows = byKey.get(entry.termRu);
    if (!rows) continue;
    for (const c of rows) idToEn.set(c.id, entry.termEn);
  }

  console.log("\n=== Anchor plan ===");
  console.log(`  set (name_en was empty):        ${toSet.length}`);
  console.log(`  overwrite (unknown/llm->glossary): ${toOverwrite.length}`);
  console.log(`  confirm (already matched):      ${toConfirm.length}`);
  console.log(`  conflicts (manual/fpf differ):  ${conflicts.length}`);
  console.log(`  glossary terms with no concept: ${unmatched}`);
  if (conflicts.length > 0) {
    console.log("\n  Conflicts (left untouched, candidates for review):");
    for (const c of conflicts.slice(0, 20)) {
      console.log(`    ${c.code} [${c.source}]: "${c.current}" vs glossary "${c.glossary}"`);
    }
    if (conflicts.length > 20) console.log(`    ... and ${conflicts.length - 20} more`);
  }

  if (dryRun) {
    console.log("\n[dry-run] no changes written");
    return;
  }

  const applyIds = [...toSet, ...toOverwrite, ...toConfirm];
  if (applyIds.length === 0) {
    console.log("\nNothing to apply.");
    return;
  }

  // Write per-id (term_en differs per row); batched updates keep it one round-trip group.
  let written = 0;
  for (const id of applyIds) {
    const en = idToEn.get(id);
    if (!en) continue;
    await sql`
      UPDATE concept_graph.concepts
      SET name_en = ${en},
          name_en_source = 'glossary',
          name_en_status = 'ok'
      WHERE id = ${id}
    `;
    written++;
  }
  console.log(`\nApplied glossary anchor to ${written} concepts.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
