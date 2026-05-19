/**
 * Concept Graph Incremental Indexer — WP-339 Ф3
 *
 * Reusable `reindexConceptsForFiles(env, source, files, readFile)` for incremental
 * Pack-graph updates. Idempotent, content-hash skip, supports added/modified/removed.
 *
 * Scope: Pack-entities, Pack-artifacts, artifact edges, cross-Pack edges.
 * Non-Pack sources (ZP, FPF, Guides, Cells, Misconceptions) remain in full ingest.
 */

import { neon } from "@neondatabase/serverless";
import { getConceptGraphSchema, CONCEPT_GRAPH_TABLES } from "./utils/db.js";

// --- Types ---

export interface Env {
  KNOWLEDGE_DATABASE_URL: string;
  OPENAI_API_KEY: string;
  CONCEPT_GRAPH_DB_SCHEMA?: string;
}

export interface FileChange {
  path: string;
  action: "added" | "modified" | "removed";
}

interface ConceptNode {
  code: string | null;
  name: string;
  name_ru: string | null;
  name_en: string | null;
  definition: string | null;
  level: "zp" | "fpf" | "pack" | "guide" | "course" | "artifact";
  node_type: "concept" | "artifact";
  domain: string | null;
  source_doc: string | null;
  source_repo: string;
}

interface ConceptEdge {
  from_code: string;
  to_code: string;
  edge_type:
    | "prerequisite" | "related" | "part_of" | "specializes" | "contradicts"
    | "pack_cites" | "pack_depends_on" | "pack_contradicts" | "pack_extends" | "pack_implements"
    | "artifact_defines_concept";
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

interface FileResult {
  path: string;
  action: "added" | "modified" | "removed";
  status: "processed" | "skipped" | "deleted" | "error";
  error?: string;
  conceptsUpserted?: number;
  edgesUpserted?: number;
  artifactsUpserted?: number;
}

// --- Config ---

const BATCH_SIZE = 20;

// --- DB helpers ---

function db(env: Env) {
  const dsn = env.KNOWLEDGE_DATABASE_URL;
  if (!dsn) throw new Error("KNOWLEDGE_DATABASE_URL required");
  return neon(dsn.replace("-pooler", ""));
}

function conceptsTable(env: Env) {
  return CONCEPT_GRAPH_TABLES.concepts(getConceptGraphSchema(env));
}

function edgesTable(env: Env) {
  return CONCEPT_GRAPH_TABLES.concept_edges(getConceptGraphSchema(env));
}

function misconceptionsTable(env: Env) {
  return CONCEPT_GRAPH_TABLES.concept_misconceptions(getConceptGraphSchema(env));
}

// --- OpenAI Embeddings ---

async function getEmbeddings(env: Env, texts: string[]): Promise<number[][]> {
  const apiKey = env.OPENAI_API_KEY;
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
        model: "text-embedding-3-small",
        dimensions: 1024,
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
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return results;
}

function vectorToSql(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

// --- YAML frontmatter parser (from ingest-concepts.ts) ---

function parseFrontmatter(content: string): { meta: Record<string, any>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, any> = {};
  const lines = match[1].split("\n");
  let currentKey = "";
  let currentSubKey = "";
  let inNestedObject = false;
  let inArray = false;

  for (const line of lines) {
    const kvMatch = line.match(/^(\w[\w_]*)\s*:\s*(.*)$/);
    const nestedKvMatch = line.match(/^(\s{1,})(\w[\w_]*)\s*:\s*(.*)$/);

    if (kvMatch) {
      currentKey = kvMatch[1];
      currentSubKey = "";
      inNestedObject = false;
      inArray = false;
      const val = kvMatch[2].trim();
      if (val === "" || val === ">") {
        meta[currentKey] = {};
        inNestedObject = true;
      } else if (val.startsWith("[") && val.endsWith("]")) {
        meta[currentKey] = val
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
          .filter((s) => s.length > 0);
        inNestedObject = false;
      } else {
        meta[currentKey] = val.replace(/^['"]|['"]$/g, "");
        inNestedObject = false;
      }
    } else if (nestedKvMatch && inNestedObject && currentKey) {
      currentSubKey = nestedKvMatch[2];
      const val = nestedKvMatch[3].trim();
      if (typeof meta[currentKey] !== "object" || Array.isArray(meta[currentKey])) {
        meta[currentKey] = {};
      }
      if (val.startsWith("[") && val.endsWith("]")) {
        meta[currentKey][currentSubKey] = val
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
          .filter((s) => s.length > 0);
      } else if (val === "") {
        meta[currentKey][currentSubKey] = [];
      } else {
        meta[currentKey][currentSubKey] = val.replace(/^['"]|['"]$/g, "");
      }
    } else if (line.match(/^\s+-\s+/)) {
      const item = line.replace(/^\s+-\s+/, "").trim();
      if (inNestedObject && currentSubKey) {
        if (!Array.isArray(meta[currentKey][currentSubKey])) {
          meta[currentKey][currentSubKey] = [];
        }
        meta[currentKey][currentSubKey].push(item);
      } else {
        if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
        meta[currentKey].push(item);
      }
      inArray = true;
    } else if (!inNestedObject && inArray === false && currentKey && line.match(/^\s+\S/)) {
      if (typeof meta[currentKey] === "string") {
        meta[currentKey] += " " + line.trim();
      }
    }
  }

  for (const key of Object.keys(meta)) {
    if (typeof meta[key] === "object" && !Array.isArray(meta[key]) && Object.keys(meta[key]).length === 0) {
      meta[key] = "";
    }
  }

  return { meta, body: match[2] };
}

// --- Extraction: single Pack file ---

const RELATION_TO_EDGE: Record<string, ConceptEdge["edge_type"]> = {
  uses: "related",
  references: "related",
  distinguishes: "related",
  prevents: "related",
  aggregates: "related",
  extends: "specializes",
  refines: "specializes",
  specializes: "specializes",
  part_of: "part_of",
  violates: "related",
};

const CONTEXTUAL_EDGE_MAP: Record<string, ConceptEdge["edge_type"]> = {
  "связано с": "pack_cites",
  "противопоставлено": "pack_contradicts",
  "опирается на": "pack_depends_on",
  "расширяет": "pack_extends",
  "реализует": "pack_implements",
};

function detectArtifactEdgeType(textBeforeLink: string): ConceptEdge["edge_type"] {
  const lower = textBeforeLink.toLowerCase();
  for (const [phrase, edgeType] of Object.entries(CONTEXTUAL_EDGE_MAP)) {
    if (lower.includes(phrase)) return edgeType;
  }
  return "pack_cites";
}

interface ExtractedFile {
  concepts: ConceptNode[];
  edges: ConceptEdge[];
  misconceptions: Misconception[];
  contentHash: string;
}

async function contentHash(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function extractPackFile(sourceRepo: string, filePath: string, content: string): ExtractedFile {
  const { meta, body } = parseFrontmatter(content);
  const concepts: ConceptNode[] = [];
  const edges: ConceptEdge[] = [];
  const misconceptions: Misconception[] = [];

  // 1. Concept node (if meta.id present)
  if (meta.id) {
    const code = meta.id;
    const domain = code.split(".")[0];
    const h1Match = body.match(/^#\s+(.+)/m);
    const h1Name = h1Match ? h1Match[1].replace(/\s*\(.*?\)\s*$/, "").replace(/^[^:]+:\s*/, "").trim() : null;
    const summaryName = typeof meta.summary === "string" ? meta.summary.split(".")[0].split(",")[0].trim().slice(0, 120) : null;
    const name = meta.name || meta.title || h1Name || summaryName || code;
    const firstParagraph = body.match(/(?:^|\n)(?!#)([^\n]+)/);
    const definition = firstParagraph ? firstParagraph[1].trim().slice(0, 500) : null;

    // Related edges from frontmatter
    if (meta.related) {
      if (Array.isArray(meta.related)) {
        for (const ref of meta.related) {
          if (typeof ref === "string" && ref.match(/^[A-Z]+\.[A-Z]+\.\d+/)) {
            edges.push({ from_code: code, to_code: ref, edge_type: "related", weight: 0.5, weight_source: "manual" });
          }
        }
      } else if (typeof meta.related === "object" && meta.related !== null) {
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

    concepts.push({
      code,
      name,
      name_ru: typeof meta.name_ru === "string" ? meta.name_ru : null,
      name_en: typeof meta.name_en === "string" ? meta.name_en : null,
      definition,
      level: "pack",
      node_type: "concept",
      domain,
      source_doc: filePath,
      source_repo: sourceRepo,
    });
  }

  // 2. Artifact node (every .md file in pack/)
  const artifactCode = `${sourceRepo}/${filePath}`;
  const h1Match = content.match(/^#\s+(.+)/m);
  const artifactName = meta.title || meta.name || (h1Match ? h1Match[1].trim() : filePath.split("/").pop()!);

  concepts.push({
    code: artifactCode,
    name: artifactName,
    name_ru: null,
    name_en: null,
    definition: null,
    level: "artifact",
    node_type: "artifact",
    domain: sourceRepo.replace("PACK-", ""),
    source_doc: filePath,
    source_repo: sourceRepo,
  });

  // 3. artifact_defines_concept edge (if concept exists in same file)
  if (meta.id) {
    edges.push({
      from_code: artifactCode,
      to_code: meta.id,
      edge_type: "artifact_defines_concept",
      weight: 0.95,
      weight_source: "manual",
    });
  }

  // 4. Markdown link edges (computed, resolved later via conceptToArtifact map)
  // These are deferred to a second pass after we have the full map.
  // We store them as "unresolved" — the caller resolves via DB map.

  // 5. Misconceptions (if file is in CAT.001 — not Pack, skip here)

  return { concepts, edges, misconceptions, contentHash: "" };
}

// Resolve markdown links in a file body using conceptToArtifact map
function resolveMarkdownLinks(
  artifactCode: string,
  body: string,
  conceptToArtifact: Map<string, string>
): ConceptEdge[] {
  const edges: ConceptEdge[] = [];
  const linkRegex = /\[([A-Z][A-Z.]*\.\d+)[^\]]*\]/g;

  for (const match of body.matchAll(linkRegex)) {
    const conceptCode = match[1];
    const startIdx = match.index || 0;
    const textBefore = body.slice(Math.max(0, startIdx - 120), startIdx);
    const edgeType = detectArtifactEdgeType(textBefore);

    const targetArtifactCode = conceptToArtifact.get(conceptCode);
    if (targetArtifactCode && targetArtifactCode !== artifactCode) {
      edges.push({
        from_code: artifactCode,
        to_code: targetArtifactCode,
        edge_type: edgeType,
        weight: edgeType === "pack_cites" ? 0.4 : 0.7,
        weight_source: "computed",
      });
    }
  }
  return edges;
}

// Cross-Pack edges for README/CLAUDE.md
const CROSS_PACK_PATTERN = /PACK-[\w-]+/g;
const NEGATIVE_CONTEXT_WORDS = ["расформирован", "поглощён", "бывший", "deprecated", "archived", "закрыт", "closed", "disbanded", "merged into"];

function hasNegativeContext(line: string): boolean {
  const lower = line.toLowerCase();
  return NEGATIVE_CONTEXT_WORDS.some((word) => lower.includes(word.toLowerCase()));
}

function extractCrossPackEdges(sourceRepo: string, filePath: string, content: string, existingArtifactCodes: Set<string>): ConceptEdge[] {
  const edges: ConceptEdge[] = [];
  const seen = new Set<string>();
  const { body } = parseFrontmatter(content);
  const text = body || content;

  const mentioned = new Set<string>();
  for (const line of text.split("\n")) {
    for (const match of line.matchAll(CROSS_PACK_PATTERN)) {
      const targetPack = match[0];
      if (targetPack === sourceRepo) continue;
      if (hasNegativeContext(line)) continue;
      mentioned.add(targetPack);
    }
  }

  const fromCode = `${sourceRepo}/${filePath}`;
  for (const targetPack of mentioned) {
    const toCode = `${targetPack}/README.md`;
    const edgeKey = `${fromCode}→${toCode}`;
    if (seen.has(edgeKey)) continue;
    if (!existingArtifactCodes.has(fromCode) || !existingArtifactCodes.has(toCode)) continue;
    edges.push({
      from_code: fromCode,
      to_code: toCode,
      edge_type: "pack_depends_on",
      weight: 0.5,
      weight_source: "manual",
    });
    seen.add(edgeKey);
  }

  return edges;
}

// --- Main function ---

export async function reindexConceptsForFiles(
  env: Env,
  source: string,
  files: FileChange[],
  readFile: (path: string) => Promise<string | null>
): Promise<{ processed: number; skipped: number; deleted: number; errors: string[]; details: FileResult[] }> {
  const sql = db(env);
  const ct = conceptsTable(env);
  const et = edgesTable(env);
  const result = { processed: 0, skipped: 0, deleted: 0, errors: [] as string[], details: [] as FileResult[] };

  // Preload concept→artifact map from DB (for markdown link resolution)
  const conceptToArtifact = new Map<string, string>();
  const dbConcepts = await sql`
    SELECT code, source_repo, source_doc
    FROM ${sql.unsafe(ct)}
    WHERE node_type = 'concept' AND code IS NOT NULL
  `;
  for (const row of dbConcepts) {
    const expectedArtifact = `${row.source_repo}/${row.source_doc}`;
    conceptToArtifact.set(row.code as string, expectedArtifact as string);
  }

  // Preload all artifact codes from DB (for cross-pack edge validation)
  const dbArtifacts = await sql`
    SELECT code FROM ${sql.unsafe(ct)} WHERE node_type = 'artifact' AND code IS NOT NULL
  `;
  const artifactCodes = new Set(dbArtifacts.map((r) => r.code as string));

  // Update local maps with concepts from changed files (so new concepts are resolvable within batch)
  // We build a temporary map from the changed files themselves before DB write.
  const localConceptToArtifact = new Map(conceptToArtifact);
  const localArtifactCodes = new Set(artifactCodes);

  for (const file of files) {
    if (!file.path.endsWith(".md")) {
      result.skipped++;
      result.details.push({ path: file.path, action: file.action, status: "skipped" });
      continue;
    }

    try {
      if (file.action === "removed") {
        // Delete all nodes for this file
        const deletedNodes = await sql`
          DELETE FROM ${sql.unsafe(ct)}
          WHERE source_repo = ${source} AND source_doc = ${file.path}
          RETURNING id
        `;
        const deletedIds = deletedNodes.map((r) => r.id);
        if (deletedIds.length > 0) {
          await sql`
            DELETE FROM ${sql.unsafe(et)}
            WHERE from_concept_id = ANY(${deletedIds}) OR to_concept_id = ANY(${deletedIds})
          `;
        }
        result.deleted += deletedIds.length;
        result.details.push({ path: file.path, action: file.action, status: "deleted", conceptsUpserted: 0, edgesUpserted: 0, artifactsUpserted: 0 });
        continue;
      }

      // Read content
      const content = await readFile(file.path);
      if (!content) {
        result.errors.push(`${file.path}: cannot read content`);
        result.details.push({ path: file.path, action: file.action, status: "error", error: "cannot read content" });
        continue;
      }

      // Content-hash skip
      const hash = await contentHash(content);
      const existing = await sql`
        SELECT content_hash FROM ${sql.unsafe(ct)}
        WHERE source_repo = ${source} AND source_doc = ${file.path}
        LIMIT 1
      `;
      if (existing.length > 0 && existing[0].content_hash === hash) {
        result.skipped++;
        result.details.push({ path: file.path, action: file.action, status: "skipped" });
        continue;
      }

      // Extract concepts/edges from file
      const extracted = extractPackFile(source, file.path, content);
      extracted.contentHash = hash;

      // Resolve markdown link edges using updated map
      const { body } = parseFrontmatter(content);
      for (const concept of extracted.concepts) {
        if (concept.node_type === "concept" && concept.code) {
          localConceptToArtifact.set(concept.code, `${source}/${file.path}`);
        }
        if (concept.node_type === "artifact" && concept.code) {
          localArtifactCodes.add(concept.code);
        }
      }

      // Add markdown link edges for artifacts
      const artifactConcept = extracted.concepts.find((c) => c.node_type === "artifact");
      if (artifactConcept && body) {
        const linkEdges = resolveMarkdownLinks(artifactConcept.code!, body, localConceptToArtifact);
        extracted.edges.push(...linkEdges);
      }

      // Add cross-pack edges for README/CLAUDE.md
      if (file.path === "README.md" || file.path === "CLAUDE.md") {
        const crossEdges = extractCrossPackEdges(source, file.path, content, localArtifactCodes);
        extracted.edges.push(...crossEdges);
      }

      // Delete old edges for nodes of this file
      const oldNodes = await sql`
        SELECT id FROM ${sql.unsafe(ct)}
        WHERE source_repo = ${source} AND source_doc = ${file.path}
      `;
      const oldIds = oldNodes.map((r) => r.id);
      if (oldIds.length > 0) {
        await sql`
          DELETE FROM ${sql.unsafe(et)}
          WHERE from_concept_id = ANY(${oldIds})
        `;
      }

      // Upsert concepts (with embeddings if new or changed)
      const embeddingTexts = extracted.concepts.map((c) => {
        const parts = [c.name];
        if (c.definition) parts.push(c.definition);
        return parts.join(": ");
      });
      const embeddings = await getEmbeddings(env, embeddingTexts);

      for (let i = 0; i < extracted.concepts.length; i++) {
        const c = extracted.concepts[i];
        const emb = embeddings[i];
        await sql`
          INSERT INTO ${sql.unsafe(ct)} (code, name, name_ru, name_en, definition, level, node_type, domain, source_doc, source_repo, embedding, content_hash)
          VALUES (${c.code}, ${c.name}, ${c.name_ru ?? null}, ${c.name_en ?? null}, ${c.definition}, ${c.level}, ${c.node_type}, ${c.domain}, ${c.source_doc}, ${c.source_repo}, ${vectorToSql(emb)}::vector, ${hash})
          ON CONFLICT (code) DO UPDATE SET
            name = EXCLUDED.name,
            name_ru = COALESCE(EXCLUDED.name_ru, ${sql.unsafe(ct)}.name_ru),
            name_en = COALESCE(EXCLUDED.name_en, ${sql.unsafe(ct)}.name_en),
            definition = EXCLUDED.definition,
            level = EXCLUDED.level,
            node_type = EXCLUDED.node_type,
            domain = EXCLUDED.domain,
            source_doc = EXCLUDED.source_doc,
            source_repo = EXCLUDED.source_repo,
            embedding = EXCLUDED.embedding,
            content_hash = EXCLUDED.content_hash,
            updated_at = NOW()
        `;
      }

      // Upsert edges
      let edgesWritten = 0;
      for (const e of extracted.edges) {
        try {
          await sql`
            INSERT INTO ${sql.unsafe(et)} (from_concept_id, to_concept_id, edge_type, weight, weight_source)
            SELECT f.id, t.id, ${e.edge_type}, ${e.weight}, ${e.weight_source}
            FROM ${sql.unsafe(ct)} f, ${sql.unsafe(ct)} t
            WHERE f.code = ${e.from_code} AND t.code = ${e.to_code}
            ON CONFLICT (from_concept_id, to_concept_id, edge_type) DO UPDATE SET
              weight = EXCLUDED.weight,
              weight_source = EXCLUDED.weight_source
          `;
          edgesWritten++;
        } catch (err) {
          // Skip edges where target concept doesn't exist yet
        }
      }

      result.processed++;
      result.details.push({
        path: file.path,
        action: file.action,
        status: "processed",
        conceptsUpserted: extracted.concepts.length,
        edgesUpserted: edgesWritten,
        artifactsUpserted: extracted.concepts.filter((c) => c.node_type === "artifact").length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      result.errors.push(`${file.path}: ${msg}`);
      result.details.push({ path: file.path, action: file.action, status: "error", error: msg });
    }
  }

  return result;
}
