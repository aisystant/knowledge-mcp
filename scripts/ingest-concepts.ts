#!/usr/bin/env npx tsx
/**
 * Concept Graph Ingestion — WP-208
 *
 * Extracts concepts from ZP, FPF, Pack entities, curriculum cells, and misconceptions.
 * Builds weighted concept graph in Neon PostgreSQL.
 *
 * Sources:
 *   1. ZP/principles/          → 6 fundamental principles (level: zp)
 *   2. DS-principles-curriculum/cells/ → 15 curriculum cells with prerequisites
 *   3. PACK-{name}/pack/       → domain entities (level: pack)
 *   4. DS-principles-curriculum/data/curriculum/CAT.001/ → misconceptions
 *   5. FPF/FPF-Spec.md         → meta-ontology patterns (level: fpf)
 *
 * Usage:
 *   npx tsx scripts/ingest-concepts.ts
 *   npx tsx scripts/ingest-concepts.ts --dry-run   # preview without DB writes
 *
 * Environment:
 *   DATABASE_URL — Neon PostgreSQL
 *   OPENAI_API_KEY — for embeddings (text-embedding-3-small, 1024d)
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, extname, dirname } from "path";
import { fileURLToPath } from "url";
import { neon } from "@neondatabase/serverless";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .dev.vars if env vars not set
if (!process.env.DATABASE_URL || !process.env.OPENAI_API_KEY) {
  const devVarsPath = join(__dirname, "../.dev.vars");
  if (existsSync(devVarsPath)) {
    const vars = readFileSync(devVarsPath, "utf-8");
    for (const line of vars.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.+)/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].trim();
      }
    }
  }
}

// --- Config ---

const IWE_ROOT = process.env.IWE_ROOT || join(process.env.HOME!, "IWE");
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIM = 1024;
const BATCH_SIZE = 20;
const DRY_RUN = process.argv.includes("--dry-run");

// --- Types ---

interface ConceptNode {
  code: string | null;
  name: string;
  definition: string | null;
  level: "zp" | "fpf" | "pack" | "guide" | "course";
  domain: string | null;
  source_doc: string | null;
  source_repo: string;
}

interface ConceptEdge {
  from_code: string;
  to_code: string;
  edge_type: "prerequisite" | "related" | "part_of" | "specializes" | "contradicts";
  weight: number;
  weight_source: "manual" | "llm" | "pmi" | "embedding" | "computed";
}

interface Misconception {
  concept_code: string | null;
  category: "wrong_concept" | "wrong_application" | "folk_substitution";
  misconception_text: string;
  correct_version: string | null;
  folk_term: string | null;
  source_file: string;
}

// --- OpenAI Embeddings ---

async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY required");

  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: batch,
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIM,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI error: ${response.status} ${text}`);
    }

    const data = (await response.json()) as {
      data: { embedding: number[] }[];
    };
    results.push(...data.data.map((d) => d.embedding));

    if (i + BATCH_SIZE < texts.length) {
      await new Promise((r) => setTimeout(r, 200)); // rate limit
    }
  }
  return results;
}

// --- YAML frontmatter parser (simple, no dependency) ---

function parseFrontmatter(content: string): { meta: Record<string, any>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, any> = {};
  const lines = match[1].split("\n");
  let currentKey = "";
  let inArray = false;

  for (const line of lines) {
    const kvMatch = line.match(/^(\w[\w_]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();
      if (val === "" || val === ">") {
        meta[currentKey] = "";
        inArray = false;
      } else if (val.startsWith("[") && val.endsWith("]")) {
        meta[currentKey] = val
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
        inArray = false;
      } else {
        meta[currentKey] = val.replace(/^['"]|['"]$/g, "");
        inArray = false;
      }
    } else if (line.match(/^\s+-\s+/)) {
      if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
      meta[currentKey].push(line.replace(/^\s+-\s+/, "").trim());
      inArray = true;
    } else if (inArray === false && currentKey && line.match(/^\s+\S/)) {
      // continuation of multi-line value
      meta[currentKey] += " " + line.trim();
    }
  }

  return { meta, body: match[2] };
}

// --- Source 1: ZP Principles ---

function extractZP(): { concepts: ConceptNode[]; edges: ConceptEdge[] } {
  const dir = join(IWE_ROOT, "ZP/principles");
  if (!existsSync(dir)) {
    console.log("  [skip] ZP/principles/ not found");
    return { concepts: [], edges: [] };
  }

  const concepts: ConceptNode[] = [];
  const edges: ConceptEdge[] = [];

  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  for (const file of files) {
    const content = readFileSync(join(dir, file), "utf-8");
    const codeMatch = file.match(/^(ZP\.\d+)/);
    if (!codeMatch) continue;

    const code = codeMatch[1];
    const titleMatch = content.match(/^#\s+.*?—\s+(.+)/m);
    const name = titleMatch ? titleMatch[1].trim() : file.replace(".md", "");

    // Extract definition from ## Определение
    const defMatch = content.match(/##\s+Определение\n\n([^\n]+)/);
    const definition = defMatch ? defMatch[1].trim() : null;

    // Extract FPF links from ## Связь с FPF
    const fpfSection = content.match(/##\s+Связь с FPF\n([\s\S]*?)(?=\n##|\n$|$)/);
    if (fpfSection) {
      const fpfRefs = fpfSection[1].matchAll(/([A-Z]\.\d+(?:\.\d+)?)\s/g);
      for (const ref of fpfRefs) {
        edges.push({
          from_code: code,
          to_code: ref[1],
          edge_type: "related",
          weight: 0.7,
          weight_source: "manual",
        });
      }
    }

    concepts.push({
      code,
      name,
      definition,
      level: "zp",
      domain: null,
      source_doc: `principles/${file}`,
      source_repo: "ZP",
    });
  }

  // ZP→ZP edges: sequential prerequisite chain
  for (let i = 1; i < concepts.length; i++) {
    edges.push({
      from_code: concepts[i - 1].code!,
      to_code: concepts[i].code!,
      edge_type: "related",
      weight: 0.5,
      weight_source: "manual",
    });
  }

  console.log(`  ZP: ${concepts.length} concepts, ${edges.length} edges`);
  return { concepts, edges };
}

// --- Source 2: Curriculum Cells ---

function extractCurriculumCells(): { concepts: ConceptNode[]; edges: ConceptEdge[] } {
  const dir = join(IWE_ROOT, "DS-principles-curriculum/cells");
  if (!existsSync(dir)) {
    console.log("  [skip] DS-principles-curriculum/cells/ not found");
    return { concepts: [], edges: [] };
  }

  const concepts: ConceptNode[] = [];
  const edges: ConceptEdge[] = [];

  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  for (const file of files) {
    const content = readFileSync(join(dir, file), "utf-8");

    // Extract all YAML cell blocks
    const cellBlocks = content.matchAll(/cell:\n([\s\S]*?)(?=\ncell:|\n---|\n$)/g);
    for (const block of cellBlocks) {
      const yaml = block[1];

      const principleMatch = yaml.match(/principle:\s*(\S+)/);
      const nameMatch = yaml.match(/principle_name:\s*(.+)/);
      const depthMatch = yaml.match(/depth:\s*(\d+)/);

      if (!principleMatch) continue;

      const principle = principleMatch[1];
      const depth = depthMatch ? parseInt(depthMatch[1]) : 1;
      const cellCode = `${principle}@${depth}`;
      const name = nameMatch ? nameMatch[1].trim() : principle;

      // Extract can_do as definition proxy
      const canDoMatch = yaml.match(/can_do:\n((?:\s+-\s+.*\n)*)/);
      const canDo = canDoMatch
        ? canDoMatch[1]
            .split("\n")
            .filter((l) => l.match(/^\s+-/))
            .map((l) => l.replace(/^\s+-\s+/, "").replace(/^["']|["']$/g, ""))
            .join("; ")
        : null;

      // Extract prerequisites
      const sameMatch = yaml.match(/same_principle:\s*(\S+@\d+)/);
      if (sameMatch && sameMatch[1] !== "null") {
        edges.push({
          from_code: sameMatch[1],
          to_code: cellCode,
          edge_type: "prerequisite",
          weight: 0.9,
          weight_source: "manual",
        });
      }

      const crossMatch = yaml.match(/cross_principle:\s*\[([^\]]*)\]/);
      if (crossMatch && crossMatch[1].trim()) {
        const refs = crossMatch[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
        for (const ref of refs) {
          if (ref && ref !== "null" && ref !== "") {
            edges.push({
              from_code: ref,
              to_code: cellCode,
              edge_type: "prerequisite",
              weight: 0.7,
              weight_source: "manual",
            });
          }
        }
      }

      // Extract method references
      const primaryMatch = yaml.match(/primary:\s*\[([^\]]*)\]/);
      if (primaryMatch && primaryMatch[1].trim()) {
        const methods = primaryMatch[1].split(",").map((s) => s.trim());
        for (const method of methods) {
          if (method) {
            edges.push({
              from_code: method,
              to_code: cellCode,
              edge_type: "related",
              weight: 0.6,
              weight_source: "manual",
            });
          }
        }
      }

      concepts.push({
        code: cellCode,
        name: `${name} (Bloom ${depth})`,
        definition: canDo,
        level: "course",
        domain: principle.startsWith("ZP") ? null : principle.split(".")[0],
        source_doc: `cells/${file}`,
        source_repo: "DS-principles-curriculum",
      });
    }
  }

  console.log(`  Cells: ${concepts.length} concepts, ${edges.length} edges`);
  return { concepts, edges };
}

// --- Source 3: Guides (Руководства) ---

function extractGuides(): { concepts: ConceptNode[]; edges: ConceptEdge[] } {
  const baseDir = join(IWE_ROOT, "docs/docs/ru");
  if (!existsSync(baseDir)) {
    console.log("  [skip] docs/docs/ru/ not found");
    return { concepts: [], edges: [] };
  }

  const concepts: ConceptNode[] = [];
  const edges: ConceptEdge[] = [];
  const allFiles = walkDir(baseDir).filter((f) => f.endsWith(".md"));
  const seenConcepts = new Map<string, string>(); // name → code (dedup)
  let guideIdx = 0;

  for (const filepath of allFiles) {
    const content = readFileSync(filepath, "utf-8");

    // Parse "**Основные понятия**: term1, term2, ..." pattern
    const conceptListMatch = content.match(/\*\*Основные понятия\*\*\s*[:\s]\s*(.+)/);
    if (!conceptListMatch) continue;

    const relPath = filepath.slice(baseDir.length + 1);
    const terms = conceptListMatch[1]
      .split(/[,،;]/)
      .map((t) => t.trim().replace(/\.$/, "").replace(/\*\*/g, ""))
      .filter((t) => t.length > 1 && t.length < 100);

    // Determine course/section from path: personal/1-1-self-development/05-role/...
    const pathParts = relPath.split("/");
    const courseName = pathParts.length > 1 ? pathParts[1] : pathParts[0];

    const sectionConcepts: string[] = [];

    for (const term of terms) {
      const normalized = term.toLowerCase().trim();
      if (seenConcepts.has(normalized)) {
        sectionConcepts.push(seenConcepts.get(normalized)!);
        continue;
      }

      guideIdx++;
      const code = `GUIDE.${guideIdx}`;
      seenConcepts.set(normalized, code);
      sectionConcepts.push(code);

      concepts.push({
        code,
        name: term,
        definition: null, // no definition in guide lists
        level: "guide",
        domain: courseName,
        source_doc: relPath,
        source_repo: "docs-courses",
      });
    }

    // Co-occurrence edges: concepts in the same list are related
    for (let i = 0; i < sectionConcepts.length; i++) {
      for (let j = i + 1; j < sectionConcepts.length && j < i + 5; j++) {
        // Only connect nearby concepts (window=5) to avoid noise
        edges.push({
          from_code: sectionConcepts[i],
          to_code: sectionConcepts[j],
          edge_type: "related",
          weight: 0.4,
          weight_source: "pmi",
        });
      }
    }
  }

  console.log(`  Guides: ${concepts.length} concepts (from ${allFiles.length} files), ${edges.length} edges`);
  return { concepts, edges };
}

// --- Source 4: Pack Entities ---

function extractPackEntities(): { concepts: ConceptNode[]; edges: ConceptEdge[] } {
  const concepts: ConceptNode[] = [];
  const edges: ConceptEdge[] = [];

  const packDirs = readdirSync(IWE_ROOT)
    .filter((d) => d.startsWith("PACK-") && statSync(join(IWE_ROOT, d)).isDirectory());

  for (const packDir of packDirs) {
    const packPath = join(IWE_ROOT, packDir, "pack");
    if (!existsSync(packPath)) continue;

    // Find all .md files under pack/
    const allFiles = walkDir(packPath).filter((f) => f.endsWith(".md"));

    for (const filepath of allFiles) {
      const content = readFileSync(filepath, "utf-8");
      const { meta } = parseFrontmatter(content);

      if (!meta.id) continue; // skip non-entity files

      const code = meta.id;
      const name = meta.name || code;
      const domain = code.split(".")[0]; // MIM, DP, PD, ECO, etc.

      // Extract definition from body — first paragraph after frontmatter
      const bodyStart = content.indexOf("---", content.indexOf("---") + 3);
      const body = bodyStart >= 0 ? content.slice(bodyStart + 3).trim() : "";
      const firstParagraph = body.match(/(?:^|\n)(?!#)([^\n]+)/);
      const definition = firstParagraph ? firstParagraph[1].trim().slice(0, 500) : null;

      // Extract related entities
      // Supports two formats:
      // Flat array: related: [DP.X.001, DP.Y.002]
      // Nested object: related:\n  uses: [DP.X.001]\n  extends: [DP.Y.002]
      if (meta.related) {
        // Map nested relation types to graph edge types
        const RELATION_TO_EDGE: Record<string, ConceptEdge["edge_type"]> = {
          uses:         "related",
          references:   "related",
          distinguishes:"related",
          prevents:     "related",
          aggregates:   "related",
          extends:      "specializes",
          refines:      "specializes",
          part_of:      "part_of",
          violates:     "related",
        };

        if (Array.isArray(meta.related)) {
          // Flat array format: related: [DP.X.001, DP.Y.002]
          for (const ref of meta.related) {
            if (typeof ref === "string" && ref.match(/^[A-Z]+\.[A-Z]+\.\d+/)) {
              edges.push({
                from_code: code,
                to_code: ref,
                edge_type: "related",
                weight: 0.5,
                weight_source: "manual",
              });
            }
          }
        } else if (typeof meta.related === "object" && meta.related !== null) {
          // Nested object format: related:\n  uses: [...]\n  extends: [...]
          for (const [relType, refs] of Object.entries(meta.related)) {
            const edgeType = RELATION_TO_EDGE[relType] ?? "related";
            const refList = Array.isArray(refs) ? refs : [refs];
            for (const ref of refList) {
              if (typeof ref === "string" && ref.trim().match(/^[A-Z][A-Z.]+\.\d+/)) {
                edges.push({
                  from_code: code,
                  to_code: ref.trim(),
                  edge_type: edgeType,
                  weight: edgeType === "specializes" ? 0.9 : 0.5,
                  weight_source: "manual",
                });
              }
            }
          }
        }
      }

      const relPath = filepath.slice(join(IWE_ROOT, packDir).length + 1);

      concepts.push({
        code,
        name,
        definition,
        level: "pack",
        domain,
        source_doc: relPath,
        source_repo: packDir,
      });
    }
  }

  console.log(`  Pack: ${concepts.length} concepts, ${edges.length} edges`);
  return { concepts, edges };
}

// --- Source 4: CAT.001 Misconceptions ---

function extractMisconceptions(): Misconception[] {
  const dir = join(IWE_ROOT, "DS-principles-curriculum/data/curriculum/CAT.001");
  if (!existsSync(dir)) {
    console.log("  [skip] CAT.001/ not found");
    return [];
  }

  const misconceptions: Misconception[] = [];

  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  for (const file of files) {
    const content = readFileSync(join(dir, file), "utf-8");
    const { meta, body } = parseFrontmatter(content);

    const name = meta.name || file;

    // Determine category from content
    let category: Misconception["category"] = "wrong_application";
    if (body.includes("подмен") || body.includes("бытов")) {
      category = "folk_substitution";
    } else if (body.includes("неверн") || body.includes("ошибочн")) {
      category = "wrong_concept";
    }

    // Extract correct version from "Продуктивный антитезис"
    const antithesisMatch = body.match(/Продуктивный антитезис[:\s]*([^\n]+)/i);
    const correctVersion = antithesisMatch ? antithesisMatch[1].trim() : null;

    misconceptions.push({
      concept_code: meta.id || null,
      category,
      misconception_text: typeof name === "string" ? name.replace(/^["']|["']$/g, "") : name,
      correct_version: correctVersion,
      folk_term: null,
      source_file: file,
    });
  }

  console.log(`  Misconceptions: ${misconceptions.length}`);
  return misconceptions;
}

// --- Source 5: FPF Patterns (top-level only) ---

function extractFPF(): { concepts: ConceptNode[]; edges: ConceptEdge[] } {
  const fpfPath = join(IWE_ROOT, "FPF/FPF-Spec.md");
  if (!existsSync(fpfPath)) {
    console.log("  [skip] FPF/FPF-Spec.md not found");
    return { concepts: [], edges: [] };
  }

  const content = readFileSync(fpfPath, "utf-8");
  const concepts: ConceptNode[] = [];
  const edges: ConceptEdge[] = [];

  // Extract ## headers as pattern names (top-level patterns only)
  const patternHeaders = content.matchAll(/^## ([A-K]\.\d+(?:\.\d+)?)\s*[-—]\s*(.+)/gm);
  const seen = new Set<string>();

  for (const match of patternHeaders) {
    const code = match[1];
    const name = match[2].trim();

    // Skip sub-sub-patterns (A.1.2.3)
    if (code.split(".").length > 3) continue;
    if (seen.has(code)) continue;
    seen.add(code);

    // Extract first paragraph after header as definition
    const headerPos = content.indexOf(match[0]);
    const nextContent = content.slice(headerPos + match[0].length, headerPos + match[0].length + 500);
    const defMatch = nextContent.match(/\n\n([^\n#]+)/);
    const definition = defMatch ? defMatch[1].trim().slice(0, 300) : null;

    concepts.push({
      code,
      name,
      definition,
      level: "fpf",
      domain: null,
      source_doc: "FPF-Spec.md",
      source_repo: "FPF",
    });

    // Parent-child edges: A.1 → A.1.1
    const parentCode = code.split(".").slice(0, -1).join(".");
    if (parentCode && seen.has(parentCode)) {
      edges.push({
        from_code: parentCode,
        to_code: code,
        edge_type: "part_of",
        weight: 0.8,
        weight_source: "manual",
      });
    }
  }

  console.log(`  FPF: ${concepts.length} concepts, ${edges.length} edges`);
  return { concepts, edges };
}

// --- Specializes edges: Pack type code → FPF parent (SPF.SPEC.002 mapping) ---

const SPF_TYPE_TO_FPF: Record<string, string[]> = {
  // Base types (SPF)
  "M":    ["U.Method"],
  "WP":   ["U.Work", "U.Episteme"],
  "FM":   [],                          // SPF-specific, no FPF parent
  "D":    [],                          // A.7 Strict Distinction (pattern, not U.* type)
  "R":    ["U.RoleAssignment"],
  "CHR":  ["U.Characteristic"],
  "SOTA": [],                          // SPF-specific
  "MAP":  ["U.Episteme"],
  "SC":   ["U.ServiceClause"],
  // Extended types (from Pack manifests)
  "FMT":  ["U.Method"],               // MIM: Format = method for organizing
  "PRG":  ["U.Episteme"],             // MIM: Program = knowledge artifact
  "FORM": ["U.Episteme"],             // MIM: Formalization
  "SOP":  ["U.Method"],               // MIM: Standard Operating Procedure
  "ARCH": ["U.System", "U.Episteme"], // DP: Architecture
  "CONCEPT": ["U.Episteme"],          // DP: Concept
  "SYS":  ["U.System"],               // DP: System
  "ROLE": ["U.RoleAssignment"],       // DP: Role (alias)
  "AISYS": ["U.System", "U.Capability"], // DP: AI System
  "NAV":  ["U.Episteme"],             // DP: Navigation
  "EXOCORTEX": ["U.System"],          // DP: Exocortex
};

function buildSpecializesEdges(
  packConcepts: ConceptNode[],
  fpfConcepts: ConceptNode[]
): ConceptEdge[] {
  const edges: ConceptEdge[] = [];
  const fpfCodes = new Set(fpfConcepts.map((c) => c.code).filter(Boolean));

  for (const concept of packConcepts) {
    if (!concept.code) continue;

    // Extract type from code: "MIM.M.006" → "M", "DP.ARCH.001" → "ARCH"
    const parts = concept.code.split(".");
    if (parts.length < 2) continue;
    const typeCode = parts[1];

    const fpfParents = SPF_TYPE_TO_FPF[typeCode];
    if (!fpfParents || fpfParents.length === 0) continue;

    for (const fpfParent of fpfParents) {
      // Find matching FPF concept in graph (U.Method → look for "Method" in FPF concepts)
      // FPF concepts have codes like "A.3" for Method, not "U.Method"
      // We store the edge with the U.* name — will resolve at DB level
      edges.push({
        from_code: concept.code,
        to_code: fpfParent,
        edge_type: "specializes",
        weight: 0.95,
        weight_source: "manual",
      });
    }
  }

  console.log(`  Specializes (Pack→FPF): ${edges.length} edges`);
  return edges;
}

// --- Guide→FPF/Pack edges via embedding cosine (computed at ingest time) ---
// These are built AFTER embeddings are generated, in the main() function.
// Mitigation (АрхГейт L2.2): edges with cosine < 0.8 are flagged for review.

interface SuspiciousEdge {
  guide_code: string;
  guide_name: string;
  matched_code: string;
  matched_name: string;
  cosine: number;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function buildGuideSpecializesEdges(
  guideConcepts: ConceptNode[],
  anchorConcepts: ConceptNode[], // ZP + FPF + Pack
  guideEmbeddings: number[][],
  anchorEmbeddings: number[][],
  guideStartIdx: number,
  anchorStartIdx: number
): { edges: ConceptEdge[]; suspicious: SuspiciousEdge[] } {
  const edges: ConceptEdge[] = [];
  const suspicious: SuspiciousEdge[] = [];
  const THRESHOLD = 0.65;
  const REVIEW_THRESHOLD = 0.8;

  for (let i = 0; i < guideConcepts.length; i++) {
    const guide = guideConcepts[i];
    if (!guide.code) continue;
    const guideEmb = guideEmbeddings[i];

    let bestScore = -1;
    let bestIdx = -1;

    for (let j = 0; j < anchorConcepts.length; j++) {
      const score = cosineSimilarity(guideEmb, anchorEmbeddings[j]);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = j;
      }
    }

    if (bestIdx >= 0 && bestScore >= THRESHOLD) {
      const anchor = anchorConcepts[bestIdx];
      edges.push({
        from_code: guide.code,
        to_code: anchor.code!,
        edge_type: "specializes",
        weight: Math.round(bestScore * 100) / 100,
        weight_source: "embedding",
      });

      // Mitigation: flag low-confidence matches for review
      if (bestScore < REVIEW_THRESHOLD) {
        suspicious.push({
          guide_code: guide.code,
          guide_name: guide.name,
          matched_code: anchor.code!,
          matched_name: anchor.name,
          cosine: Math.round(bestScore * 1000) / 1000,
        });
      }
    }
  }

  console.log(`  Specializes (Guide→anchor): ${edges.length} edges (${suspicious.length} need review, cosine < ${REVIEW_THRESHOLD})`);
  return { edges, suspicious };
}

// --- Utility ---

function walkDir(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

function vectorToSql(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

// --- Main ---

async function main() {
  console.log("=== Concept Graph Ingestion (WP-208) ===\n");

  // 1. Extract from all sources
  console.log("Step 1: Extracting concepts...\n");

  const zp = extractZP();
  const cells = extractCurriculumCells();
  const guides = extractGuides();
  const pack = extractPackEntities();
  const fpf = extractFPF();
  const misconceptions = extractMisconceptions();

  // Add U.* meta-concepts as explicit nodes (FPF level)
  const uConcepts: ConceptNode[] = [
    { code: "U.Entity", name: "Entity", definition: "Primitive of distinction — everything that can be singled out and named", level: "fpf", domain: null, source_doc: "FPF-Spec.md", source_repo: "FPF" },
    { code: "U.Holon", name: "Holon", definition: "Composition unit: simultaneously a whole composed of parts and a part of a larger whole", level: "fpf", domain: null, source_doc: "FPF-Spec.md", source_repo: "FPF" },
    { code: "U.System", name: "System", definition: "Holon with a boundary interacting with its environment", level: "fpf", domain: null, source_doc: "FPF-Spec.md", source_repo: "FPF" },
    { code: "U.Episteme", name: "Episteme", definition: "Unit of knowledge/description as an artifact", level: "fpf", domain: null, source_doc: "FPF-Spec.md", source_repo: "FPF" },
    { code: "U.Method", name: "Method", definition: "Abstract way of acting (capability); design-time", level: "fpf", domain: null, source_doc: "FPF-Spec.md", source_repo: "FPF" },
    { code: "U.Work", name: "Work", definition: "Dated, spatiotemporally bounded record of a completed enactment", level: "fpf", domain: null, source_doc: "FPF-Spec.md", source_repo: "FPF" },
    { code: "U.Role", name: "Role", definition: "Context-bound capability/obligation schema", level: "fpf", domain: null, source_doc: "FPF-Spec.md", source_repo: "FPF" },
    { code: "U.RoleAssignment", name: "RoleAssignment", definition: "First-class record: Holder#Role:Context@Window", level: "fpf", domain: null, source_doc: "FPF-Spec.md", source_repo: "FPF" },
    { code: "U.Capability", name: "Capability", definition: "Dispositional ability to act", level: "fpf", domain: null, source_doc: "FPF-Spec.md", source_repo: "FPF" },
    { code: "U.ServiceClause", name: "ServiceClause", definition: "Consumer-facing promise clause", level: "fpf", domain: null, source_doc: "FPF-Spec.md", source_repo: "FPF" },
    { code: "U.Characteristic", name: "Characteristic", definition: "Measurable evaluation axis", level: "fpf", domain: null, source_doc: "FPF-Spec.md", source_repo: "FPF" },
    { code: "U.BoundedContext", name: "BoundedContext", definition: "Semantic frame with its own vocabulary, roles, invariants, and bridges", level: "fpf", domain: null, source_doc: "FPF-Spec.md", source_repo: "FPF" },
  ];
  console.log(`  U.* meta-concepts: ${uConcepts.length}`);

  // Build specializes edges: Pack → FPF (via SPF mapping)
  const specializesPackEdges = buildSpecializesEdges(pack.concepts, [...fpf.concepts, ...uConcepts]);

  const allConcepts = [...uConcepts, ...zp.concepts, ...fpf.concepts, ...pack.concepts, ...guides.concepts, ...cells.concepts];
  const allEdges = [...zp.edges, ...fpf.edges, ...pack.edges, ...guides.edges, ...cells.edges, ...specializesPackEdges];

  console.log(`\nTotal: ${allConcepts.length} concepts, ${allEdges.length} edges, ${misconceptions.length} misconceptions\n`);

  if (DRY_RUN) {
    console.log("--- DRY RUN: Preview ---\n");

    console.log("Concepts by level:");
    const byLevel = allConcepts.reduce((acc, c) => {
      acc[c.level] = (acc[c.level] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    console.table(byLevel);

    console.log("\nEdges by type:");
    const byType = allEdges.reduce((acc, e) => {
      acc[e.edge_type] = (acc[e.edge_type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    console.table(byType);

    console.log("\nSample concepts:");
    for (const c of allConcepts.slice(0, 10)) {
      console.log(`  ${c.code || "(no code)"} | ${c.name} | ${c.level} | ${c.source_repo}`);
    }

    console.log("\nSample edges:");
    for (const e of allEdges.slice(0, 10)) {
      console.log(`  ${e.from_code} → ${e.to_code} | ${e.edge_type} | w=${e.weight}`);
    }

    console.log("\nSample misconceptions:");
    for (const m of misconceptions.slice(0, 5)) {
      console.log(`  [${m.category}] ${m.misconception_text}`);
    }

    return;
  }

  // 2. Generate embeddings
  console.log("Step 2: Generating embeddings...\n");

  const embeddingTexts = allConcepts.map((c) => {
    const parts = [c.name];
    if (c.definition) parts.push(c.definition);
    return parts.join(": ");
  });

  const embeddings = await getEmbeddings(embeddingTexts);
  console.log(`  Generated ${embeddings.length} embeddings\n`);

  // 2b. Build guide→anchor specializes edges (using embeddings)
  console.log("Step 2b: Building guide→anchor specializes edges...\n");

  const anchorConcepts = [...uConcepts, ...zp.concepts, ...fpf.concepts, ...pack.concepts];
  const anchorCount = anchorConcepts.length;
  const guideStartIdx = anchorCount; // guides start after anchors in allConcepts
  const anchorEmbeddings = embeddings.slice(0, anchorCount);
  const guideEmbeddings = embeddings.slice(guideStartIdx, guideStartIdx + guides.concepts.length);

  const { edges: guideSpecEdges, suspicious } = buildGuideSpecializesEdges(
    guides.concepts, anchorConcepts,
    guideEmbeddings, anchorEmbeddings,
    guideStartIdx, 0
  );

  // Add guide specializes edges to allEdges
  allEdges.push(...guideSpecEdges);

  // Mitigation report (АрхГейт L2.2)
  if (suspicious.length > 0) {
    console.log(`\n  ⚠️ Review needed: ${suspicious.length} edges with cosine < 0.8:`);
    for (const s of suspicious.slice(0, 20)) {
      console.log(`    ${s.guide_code} "${s.guide_name}" → ${s.matched_code} "${s.matched_name}" (cosine=${s.cosine})`);
    }
    if (suspicious.length > 20) {
      console.log(`    ... and ${suspicious.length - 20} more`);
    }
    console.log();
  }

  // 3. Write to Neon
  console.log("Step 3: Writing to Neon...\n");

  const dbUrl = process.env.DATABASE_URL?.replace("-pooler", "");
  if (!dbUrl) throw new Error("DATABASE_URL required");

  const sql = neon(dbUrl);

  // 3a. Upsert concepts
  let conceptsWritten = 0;
  for (let i = 0; i < allConcepts.length; i++) {
    const c = allConcepts[i];
    const emb = embeddings[i];

    await sql`
      INSERT INTO concept_graph.concepts (code, name, definition, level, domain, source_doc, source_repo, embedding)
      VALUES (${c.code}, ${c.name}, ${c.definition}, ${c.level}, ${c.domain}, ${c.source_doc}, ${c.source_repo}, ${vectorToSql(emb)}::vector)
      ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name,
        definition = EXCLUDED.definition,
        level = EXCLUDED.level,
        domain = EXCLUDED.domain,
        source_doc = EXCLUDED.source_doc,
        source_repo = EXCLUDED.source_repo,
        embedding = EXCLUDED.embedding,
        updated_at = NOW()
    `;
    conceptsWritten++;

    if (conceptsWritten % 50 === 0) {
      console.log(`  Concepts: ${conceptsWritten}/${allConcepts.length}`);
    }
  }
  console.log(`  Concepts written: ${conceptsWritten}\n`);

  // 3b. Upsert edges (resolve codes → IDs)
  let edgesWritten = 0;
  for (const e of allEdges) {
    try {
      const result = await sql`
        INSERT INTO concept_graph.concept_edges (from_concept_id, to_concept_id, edge_type, weight, weight_source)
        SELECT f.id, t.id, ${e.edge_type}, ${e.weight}, ${e.weight_source}
        FROM concept_graph.concepts f, concept_graph.concepts t
        WHERE f.code = ${e.from_code} AND t.code = ${e.to_code}
        ON CONFLICT (from_concept_id, to_concept_id, edge_type) DO UPDATE SET
          weight = EXCLUDED.weight,
          weight_source = EXCLUDED.weight_source
      `;
      edgesWritten++;
    } catch (err) {
      // Skip edges where one side doesn't exist yet
      console.log(`  [skip edge] ${e.from_code} → ${e.to_code}: concept not found`);
    }
  }
  console.log(`  Edges written: ${edgesWritten}/${allEdges.length}\n`);

  // 3c. Insert misconceptions
  let miscWritten = 0;
  for (const m of misconceptions) {
    try {
      await sql`
        INSERT INTO concept_graph.concept_misconceptions (concept_id, category, misconception_text, correct_version, folk_term, source_file)
        SELECT c.id, ${m.category}, ${m.misconception_text}, ${m.correct_version}, ${m.folk_term}, ${m.source_file}
        FROM concept_graph.concepts c
        WHERE c.code = ${m.concept_code}
        LIMIT 1
      `;
      miscWritten++;
    } catch {
      // Skip if concept not found
    }
  }
  console.log(`  Misconceptions written: ${miscWritten}/${misconceptions.length}\n`);

  console.log("=== Done ===");
}

main().catch(console.error);
