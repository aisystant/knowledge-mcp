/**
 * Knowledge MCP Server v4.1 — L2 Platform — Hybrid Search + Parent Retrieval + LLM Reranking + Feedback Loop
 *
 * Unified MCP server for Pack, guides, and DS knowledge.
 * Embeddings: OpenAI (text-embedding-3-small, 1024d)
 * Storage: Neon PostgreSQL with pgvector + pg_trgm + tsvector
 *
 * Search routing (DP.D.024):
 * - Entity codes (DP.AGENT.001) → keyword path (pg_trgm ILIKE, ~5ms)
 * - Natural language → vector path (cosine similarity, ~300ms)
 * - Keyword miss → fallback to vector
 * - Vector low confidence (score < 0.6) → fallback to keyword + merge
 */

import { neon } from "@neondatabase/serverless";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { withUserContext } from "./rls.js";

// --- Types ---

export interface Env {
  /**
   * WP-268 Phase 2 cut-over: target = `knowledge` БД (knowledge_chunk schema).
   * If unset, falls back to legacy `DATABASE_URL` (neondb.documents) for soak window.
   * After legacy `neondb` drop — remove DATABASE_URL and make this required.
   */
  KNOWLEDGE_DATABASE_URL?: string;
  /** @deprecated WP-268 Phase 2: legacy `neondb` connection. Use KNOWLEDGE_DATABASE_URL. */
  DATABASE_URL: string;
  OPENAI_API_KEY: string;
  ORY_URL?: string; // e.g. https://auth.system-school.ru/hydra — optional, JWT verification disabled if absent
  REINDEX_SECRET?: string; // Shared secret for /reindex endpoint (set via wrangler secret)
}

/**
 * WP-268: возвращает активный DSN для knowledge-mcp.
 * Приоритет: KNOWLEDGE_DATABASE_URL (новая `knowledge` БД) → DATABASE_URL (legacy `neondb`).
 * Используется во ВСЕХ местах, где раньше был прямой `env.DATABASE_URL`.
 */
function activeDsn(env: Env): string {
  return env.KNOWLEDGE_DATABASE_URL || env.DATABASE_URL;
}

interface McpRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

// --- Reindex types ---

interface ReindexFile {
  path: string;
  action: "added" | "modified" | "removed";
}

interface ReindexRequest {
  source: string;
  files: ReindexFile[];
}

// --- JWT verification (B4.21) ---

const _jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(oryUrl: string): ReturnType<typeof createRemoteJWKSet> {
  if (!_jwksCache.has(oryUrl)) {
    // ORY_URL is the Hydra base URL (e.g. https://auth.system-school.ru/hydra)
    // JWKS is served at <oryUrl>/.well-known/jwks.json — same pattern as gateway-mcp
    const jwksUrl = new URL(`${oryUrl}/.well-known/jwks.json`);
    _jwksCache.set(oryUrl, createRemoteJWKSet(jwksUrl));
  }
  return _jwksCache.get(oryUrl)!;
}

async function verifyJwtLocally(oryUrl: string, token: string): Promise<string | null> {
  try {
    const jwks = getJwks(oryUrl);
    const issuer = oryUrl.endsWith("/") ? oryUrl : oryUrl + "/";
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      algorithms: ["RS256"],
    });
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

// --- Config ---

const EMBEDDING_MODEL = "text-embedding-3-small";
const VECTOR_CONFIDENCE_THRESHOLD = 0.6;
const CHUNK_CHAR_LIMIT = 10_000;
const LARGE_FILE_THRESHOLD = CHUNK_CHAR_LIMIT;
const MAX_FILE_SIZE = 100_000; // 100KB
const RERANK_MODEL = "gpt-4o-mini";
const RERANK_CANDIDATES = 20; // Fetch top-N for reranking, return top-K
const RERANK_TIMEOUT_MS = 5000;
const RERANK_VECTOR_WEIGHT = 0.3;
const RERANK_LLM_WEIGHT = 0.7;

// GitHub URL mapping: source name → base URL + path prefix.
// Enables clickable source links in search results.
const SOURCE_GITHUB_BASE: Record<string, { base: string; pathPrefix: string }> = {
  "PACK-digital-platform": { base: "https://github.com/TserenTserenov/PACK-digital-platform/blob/main", pathPrefix: "pack/" },
  "PACK-personal": { base: "https://github.com/aisystant/PACK-personal/blob/main", pathPrefix: "pack/" },
  "PACK-MIM": { base: "https://github.com/TserenTserenov/PACK-MIM/blob/main", pathPrefix: "pack/" },
  "SPF": { base: "https://github.com/TserenTserenov/SPF/blob/main", pathPrefix: "" },
  "FPF": { base: "https://github.com/ailev/FPF/blob/main", pathPrefix: "" },
  "DS-ecosystem-development": { base: "https://github.com/aisystant/DS-ecosystem-development/blob/main", pathPrefix: "" },
  "aist-bot-docs": { base: "https://github.com/aisystant/aist_bot/blob/new-architecture", pathPrefix: "docs/" },
  "docs-courses": { base: "https://github.com/aisystant/docs/blob/main", pathPrefix: "docs/ru/" },
  "exocortex-template-docs": { base: "https://github.com/TserenTserenov/FMT-exocortex-template/blob/main", pathPrefix: "docs/" },
  "DS-principles-curriculum": { base: "https://github.com/aisystant/DS-principles-curriculum/blob/main", pathPrefix: "" },
  "FMT-exocortex-template": { base: "https://github.com/TserenTserenov/FMT-exocortex-template/blob/main", pathPrefix: "" },
  "FMT-s2r": { base: "https://github.com/TserenTserenov/FMT-s2r/blob/main", pathPrefix: "" },
  "DS-autonomous-agents": { base: "https://github.com/TserenTserenov/DS-autonomous-agents/blob/main", pathPrefix: "" },
  "PACK-verification": { base: "https://github.com/TserenTserenov/PACK-verification/blob/main", pathPrefix: "pack/" },
  "PACK-autonomous-agents": { base: "https://github.com/TserenTserenov/PACK-autonomous-agents/blob/main", pathPrefix: "pack/" },
  "PACK-ecosystem": { base: "https://github.com/TserenTserenov/PACK-ecosystem/blob/main", pathPrefix: "pack/" },
};

// L2 platform sources — always indexed with user_id=NULL, visible to all.
// Everything else in SOURCE_GITHUB_BASE is L4 (personal) and must have user_sources entry.
const L2_PLATFORM_SOURCES: ReadonlySet<string> = new Set([
  "FPF", "SPF",
  "PACK-digital-platform", "PACK-MIM", "PACK-personal", "PACK-ecosystem",
  "docs-courses", "aist-bot-docs", "exocortex-template-docs",
  "FMT-exocortex-template", "FMT-s2r",
]);

export function resolveGithubUrl(source: string, filename: string): string | null {
  const config = SOURCE_GITHUB_BASE[source];
  if (!config) return null;
  // Strip chunk section suffix (e.g., "FPF-Spec.md::B.1.3 - ..." → "FPF-Spec.md")
  const cleanFilename = filename.split("::")[0];
  return `${config.base}/${config.pathPrefix}${cleanFilename}`;
}

// --- Helpers ---

async function getEmbedding(apiKey: string, text: string): Promise<number[]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: [text],
      model: EMBEDDING_MODEL,
      dimensions: 1024,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI Embeddings error: ${response.status} ${errText}`);
  }

  const data = (await response.json()) as { data: { embedding: number[] }[] };
  return data.data[0].embedding;
}

function db(env: Env) {
  return neon(activeDsn(env));
}

// --- Query type detection (DP.D.024) ---

type QueryType = "keyword" | "vector";

export function detectQueryType(query: string): QueryType {
  // Entity codes: DP.AGENT.001, MIM.M.003, SOTA.002, SPF.SPEC.001, etc.
  if (/[A-Z]{2,}\.\w+\.\d+/.test(query)) return "keyword";
  // Short queries with dots — likely structured identifiers
  if (query.length < 30 && /\.[A-Z]/.test(query)) return "keyword";
  // Default: semantic vector search
  return "vector";
}

// --- Tool implementations ---

export type SearchResult = {
  id: number;
  filename: string;
  content: string;
  source: string;
  source_type: string;
  score: number;
  github_url: string | null;
  parent_content?: string;
  parent_filename?: string;
};

async function keywordSearch(
  env: Env,
  query: string,
  source?: string,
  sourceType?: string,
  limit: number = 5,
  userId?: string
): Promise<SearchResult[]> {
  const src = source ?? null;
  const stype = sourceType ?? null;
  const pattern = `%${query}%`;
  // Normalize hyphens to spaces for FTS (e.g. "ролей-агентов" → "ролей агентов")
  const ftsQuery = query.replace(/-/g, " ");

  // Extract entity code for filename match, rest for content match
  // e.g. "DP.IWE.002 §4a" → entityPattern="%DP.IWE.002%", sectionPattern="%4a%"
  const entityMatch = query.match(/[A-Z]{2,}\.\w+\.\d+/);
  const entityPattern = entityMatch ? `%${entityMatch[0]}%` : null;
  const sectionRest = entityMatch
    ? query.replace(entityMatch[0], "").replace(/[§#]/g, "").trim()
    : null;
  const sectionPattern = sectionRest ? `%${sectionRest}%` : null;

  // WP-268: knowledge_chunk schema. Aliases preserve external API contract:
  //   legacy_id AS id, source_uri AS filename, source_kind AS source_type
  const rows = await withUserContext(activeDsn(env), userId, (sql) => sql`
    SELECT legacy_id AS id, source_uri AS filename, content, source, source_kind AS source_type,
           CASE
             WHEN source_uri ILIKE ${pattern} THEN 1.0
             WHEN ${entityPattern}::text IS NOT NULL
                  AND source_uri ILIKE ${entityPattern}
                  AND ${sectionPattern}::text IS NOT NULL
                  AND content ILIKE ${sectionPattern} THEN 0.98
             WHEN source_uri ILIKE ${entityPattern} AND ${entityPattern}::text IS NOT NULL THEN 0.95
             WHEN content ILIKE ${pattern} THEN 0.90
             WHEN search_vector @@ plainto_tsquery('simple', ${ftsQuery}) THEN 0.8
             ELSE 0.5
           END AS score
    FROM knowledge_chunk
    WHERE (content ILIKE ${pattern}
           OR source_uri ILIKE ${pattern}
           OR search_vector @@ plainto_tsquery('simple', ${ftsQuery})
           OR (${entityPattern}::text IS NOT NULL AND source_uri ILIKE ${entityPattern}))
      AND (${src}::text IS NULL OR source = ${src})
      AND (${stype}::text IS NULL OR source_kind = ${stype})
    ORDER BY score DESC,
             CASE WHEN source_uri ILIKE ${pattern} THEN 0 ELSE 1 END,
             length(content) DESC
    LIMIT ${limit}
  `);

  return rows.map((r) => {
    const source = (r.source as string) || "";
    const filename = r.filename as string;
    return {
      id: r.id as number,
      filename,
      content: r.content as string,
      source,
      source_type: (r.source_type as string) || "",
      score: r.score as number,
      github_url: resolveGithubUrl(source, filename),
    };
  });
}

async function vectorSearch(
  env: Env,
  query: string,
  source?: string,
  sourceType?: string,
  limit: number = 5,
  userId?: string
): Promise<SearchResult[]> {
  const embedding = await getEmbedding(env.OPENAI_API_KEY, query);
  const vec = `[${embedding.join(",")}]`;
  const src = source ?? null;
  const stype = sourceType ?? null;

  // WP-268: knowledge_chunk schema with id/filename/source_type aliases.
  const rows = await withUserContext(activeDsn(env), userId, (sql) => sql`
    SELECT legacy_id AS id, source_uri AS filename, content, source, source_kind AS source_type,
           1 - (embedding <=> ${vec}::vector) AS score
    FROM knowledge_chunk
    WHERE embedding IS NOT NULL
      AND (${src}::text IS NULL OR source = ${src})
      AND (${stype}::text IS NULL OR source_kind = ${stype})
    ORDER BY embedding <=> ${vec}::vector
    LIMIT ${limit}
  `);

  return rows.map((r) => {
    const source = (r.source as string) || "";
    const filename = r.filename as string;
    return {
      id: r.id as number,
      filename,
      content: r.content as string,
      source,
      source_type: (r.source_type as string) || "",
      score: r.score as number,
      github_url: resolveGithubUrl(source, filename),
    };
  });
}

// --- LLM Reranking ---

interface RerankScore {
  index: number;
  relevance_score: number;
}

/**
 * LLM Reranking: sends query + candidate snippets to gpt-4o-mini for relevance scoring.
 * Returns reordered results with hybrid score (vector * 0.3 + llm * 0.7).
 * Fallback: returns original order on any error/timeout.
 */
export async function rerankWithLLM(
  apiKey: string,
  query: string,
  results: SearchResult[],
  limit: number
): Promise<SearchResult[]> {
  if (results.length <= 1) return results.slice(0, limit);

  // Prepare candidate snippets (truncate content to save tokens)
  const candidates = results.map((r, i) => ({
    index: i,
    filename: r.filename,
    snippet: r.content.slice(0, 500),
  }));

  const systemPrompt = `You are a relevance judge. Given a query and candidate documents, score each document's relevance to the query on a scale of 0.0 to 1.0.

Respond with a JSON object: {"scores": [{"index": 0, "relevance_score": 0.85}, ...]}
Include ALL candidates. Score based on how well the document answers the query.`;

  const userPrompt = `Query: ${query}

Candidates:
${candidates.map((c) => `[${c.index}] ${c.filename}\n${c.snippet}`).join("\n\n")}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: RERANK_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      // Fallback: return original order
      return results.slice(0, limit);
    }

    const data = (await response.json()) as {
      choices: { message: { content: string } }[];
    };

    const content = data.choices[0]?.message?.content;
    if (!content) return results.slice(0, limit);

    // Parse LLM scores — handle both array and {scores: [...]} formats
    const parsed = JSON.parse(content);
    const scores: RerankScore[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.scores)
        ? parsed.scores
        : [];

    if (scores.length === 0) return results.slice(0, limit);

    // Build score map
    const llmScoreMap = new Map<number, number>();
    for (const s of scores) {
      if (typeof s.index === "number" && typeof s.relevance_score === "number") {
        llmScoreMap.set(s.index, Math.max(0, Math.min(1, s.relevance_score)));
      }
    }

    // Compute hybrid score and reorder
    const reranked = results.map((r, i) => {
      const llmScore = llmScoreMap.get(i) ?? 0.5; // default 0.5 if missing
      const hybridScore = r.score * RERANK_VECTOR_WEIGHT + llmScore * RERANK_LLM_WEIGHT;
      return { ...r, score: hybridScore };
    });

    reranked.sort((a, b) => b.score - a.score);
    return reranked.slice(0, limit);
  } catch {
    // Timeout or parse error — fallback to original order
    return results.slice(0, limit);
  }
}

/** Enrich search results with parent document content when available */
export async function enrichWithParentContent(env: Env, results: SearchResult[]): Promise<SearchResult[]> {
  if (results.length === 0) return results;
  const sql = db(env);

  // Batch-fetch parent info for all results that are chunks (have parent_id)
  const filenames = results.map((r) => r.filename);
  const sources = results.map((r) => r.source);

  // WP-268: knowledge_chunk schema. Self-FK через parent_chunk_id (UUID built by mvp/014).
  // Fallback path (если parent_chunk_id ещё не построен): JOIN ON p.legacy_id = c.parent_legacy_id.
  // После apply mvp/014 — parent_chunk_id заполнен и быстрее.
  const parentRows = await sql`
    SELECT c.source_uri AS chunk_filename, c.source AS chunk_source,
           p.source_uri AS parent_filename, p.content AS parent_content
    FROM knowledge_chunk c
    JOIN knowledge_chunk p ON p.chunk_uuid = c.parent_chunk_id
    WHERE c.parent_chunk_id IS NOT NULL
      AND (c.source_uri, c.source) IN (
        SELECT unnest(${filenames}::text[]), unnest(${sources}::text[])
      )
  `;

  const parentMap = new Map<string, { parent_filename: string; parent_content: string }>();
  for (const row of parentRows) {
    const key = `${row.chunk_filename}||${row.chunk_source}`;
    parentMap.set(key, {
      parent_filename: row.parent_filename as string,
      parent_content: row.parent_content as string,
    });
  }

  return results.map((r) => {
    const parent = parentMap.get(`${r.filename}||${r.source}`);
    if (parent) {
      return { ...r, parent_filename: parent.parent_filename, parent_content: parent.parent_content };
    }
    return r;
  });
}

async function searchDocuments(
  env: Env,
  query: string,
  source?: string,
  sourceType?: string,
  limit: number = 5,
  userId?: string
): Promise<SearchResult[]> {
  const queryType = detectQueryType(query);

  if (queryType === "keyword") {
    // Keyword-first: skip embedding generation (~200ms saved), no reranking needed
    const kwResults = await keywordSearch(env, query, source, sourceType, limit, userId);
    if (kwResults.length > 0) return enrichWithParentContent(env, kwResults);
    // Fallback to vector if keyword found nothing
  }

  // Vector path: fetch extra candidates for LLM reranking
  const fetchLimit = Math.max(limit, RERANK_CANDIDATES);
  const vectorResults = await vectorSearch(env, query, source, sourceType, fetchLimit, userId);

  // Low-confidence fallback: if vector top score < threshold, try keyword
  if (vectorResults.length > 0 && vectorResults[0].score < VECTOR_CONFIDENCE_THRESHOLD) {
    const kwFallback = await keywordSearch(env, query, source, sourceType, limit, userId);
    if (kwFallback.length > 0) {
      // Merge: deduplicate by filename, keep highest score
      const seen = new Map<string, SearchResult>();
      for (const r of [...kwFallback, ...vectorResults]) {
        const existing = seen.get(r.filename);
        if (!existing || r.score > existing.score) {
          seen.set(r.filename, r);
        }
      }
      const merged = [...seen.values()].sort((a, b) => b.score - a.score);
      // Rerank merged results
      const reranked = await rerankWithLLM(env.OPENAI_API_KEY, query, merged, limit);
      return enrichWithParentContent(env, reranked);
    }
  }

  // LLM rerank vector results → return top-K
  const reranked = await rerankWithLLM(env.OPENAI_API_KEY, query, vectorResults, limit);
  return enrichWithParentContent(env, reranked);
}

async function getDocument(
  env: Env,
  filename: string,
  source?: string,
  userId?: string
): Promise<{ filename: string; content: string; source: string; source_type: string; github_url: string | null } | null> {
  const src = source ?? null;

  // WP-268: knowledge_chunk schema with field aliases.
  const rows = await withUserContext(activeDsn(env), userId, (sql) => sql`
    SELECT source_uri AS filename, content, source, source_kind AS source_type
    FROM knowledge_chunk
    WHERE source_uri = ${filename}
      AND (${src}::text IS NULL OR source = ${src})
    LIMIT 1
  `);

  if (!rows.length) return null;
  const r = rows[0];
  const docSource = (r.source as string) || "";
  const docFilename = r.filename as string;
  return {
    filename: docFilename,
    content: r.content as string,
    source: docSource,
    source_type: (r.source_type as string) || "",
    github_url: resolveGithubUrl(docSource, docFilename),
  };
}

async function listSources(
  env: Env,
  sourceType?: string,
  userId?: string
): Promise<{ source: string; source_type: string; doc_count: number }[]> {
  const stype = sourceType ?? null;

  // WP-268: knowledge_chunk schema. source_kind aliased back to source_type for API compat.
  const rows = await withUserContext(activeDsn(env), userId, (sql) => sql`
    SELECT source, source_kind AS source_type, COUNT(*)::int AS doc_count
    FROM knowledge_chunk
    WHERE (${stype}::text IS NULL OR source_kind = ${stype})
    GROUP BY source, source_kind
    ORDER BY source_kind, source
  `);

  return rows.map((r) => ({
    source: (r.source as string) || "",
    source_type: (r.source_type as string) || "",
    doc_count: r.doc_count as number,
  }));
}

// --- Feedback ---

async function recordFeedback(
  env: Env,
  documentId: number,
  query: string,
  helpfulness: boolean
): Promise<{ recorded: boolean }> {
  const sql = db(env);
  const queryHash = await hashQuery(query);
  // WP-268: retrieval_feedback таблица создаётся в новой `knowledge` БД через
  // mvp/016-knowledge-retrieval-feedback.sql. document_id ссылается на
  // knowledge_chunk.legacy_id (BIGINT), сохраняя API-совместимость.
  await sql`
    INSERT INTO retrieval_feedback (document_id, query_hash, helpfulness)
    VALUES (${documentId}, ${queryHash}, ${helpfulness})
  `;
  return { recorded: true };
}

export async function hashQuery(query: string): Promise<string> {
  const data = new TextEncoder().encode(query);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 64);
}

async function getFeedbackStats(
  env: Env,
  days: number = 30,
  limit: number = 20,
  userId?: string
): Promise<Array<{ document_id: number; filename: string; source: string; helpful: number; not_helpful: number; total: number; helpfulness_rate: number }>> {
  // WP-268: knowledge_chunk schema. JOIN: retrieval_feedback.document_id (BIGINT) → knowledge_chunk.legacy_id.
  const rows = await withUserContext(activeDsn(env), userId, (sql) => sql`
    SELECT
      f.document_id,
      d.source_uri AS filename,
      d.source,
      COUNT(*) FILTER (WHERE f.helpfulness = true)::int AS helpful,
      COUNT(*) FILTER (WHERE f.helpfulness = false)::int AS not_helpful,
      COUNT(*)::int AS total,
      ROUND(COUNT(*) FILTER (WHERE f.helpfulness = true)::numeric / NULLIF(COUNT(*), 0), 2) AS helpfulness_rate
    FROM retrieval_feedback f
    JOIN knowledge_chunk d ON d.legacy_id = f.document_id
    WHERE f.created_at >= NOW() - make_interval(days => ${days})
    GROUP BY f.document_id, d.source_uri, d.source
    ORDER BY total DESC, helpfulness_rate DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    document_id: r.document_id as number,
    filename: r.filename as string,
    source: r.source as string,
    helpful: r.helpful as number,
    not_helpful: r.not_helpful as number,
    total: r.total as number,
    helpfulness_rate: Number(r.helpfulness_rate),
  }));
}

// --- WP-208: Concept Graph — analyze_verbalization ---

interface ConceptMatch {
  code: string;
  name: string;
  level: string;
  score: number; // cosine similarity to user text segment
}

interface VerbalizationResult {
  topic: string;
  total_concepts: number;
  matched_concepts: ConceptMatch[];
  missed_concepts: { code: string; name: string; centrality: number }[];
  coverage: number; // 0-1
  edge_coverage: number; // 0-1
  misconceptions_found: { text: string; correct: string | null; category: string; explanation?: string }[];
  recommendations: string[];
  mastery_updated: boolean;
}

// WP-268 Phase 2 cut-over note: концептный граф (`concept_graph.*` schema) находится в legacy
// `neondb` и НЕ является частью этой миграции (плана не предусматривает). После cut-over на
// `knowledge` БД эти запросы СЛОМАЮТСЯ, пока concept_graph не будет мигрирован отдельным WP.
// Workaround: либо включить concept_graph в bulk ETL до production cut-over, либо хранить
// отдельный CONCEPT_DATABASE_URL secret и переключить queries ниже на него.
// Tracked in WP-268 follow-up checklist (см. PR-описание).
async function analyzeVerbalization(
  env: Env,
  text: string,
  topic: string | undefined,
  domain: string | undefined,
  level: string | undefined,
  userId: string | undefined
): Promise<VerbalizationResult> {
  const sql = db(env);

  // 1. Get topic concepts subgraph
  // If topic is given, search for concepts matching the topic
  // Otherwise use domain/level filters
  let topicConcepts: any[];

  if (topic) {
    // Embed the topic to find relevant concepts
    const topicEmbedding = await getEmbedding(env.OPENAI_API_KEY, topic);
    const vecStr = `[${topicEmbedding.join(",")}]`;
    topicConcepts = await sql`
      SELECT id, code, name, definition, level, domain,
             1 - (embedding <=> ${vecStr}::vector) AS similarity
      FROM concept_graph.concepts
      WHERE status = 'active'
      ORDER BY embedding <=> ${vecStr}::vector
      LIMIT 50
    `;
  } else {
    // Filter by domain and/or level
    topicConcepts = await sql`
      SELECT id, code, name, definition, level, domain, 1.0 AS similarity
      FROM concept_graph.concepts
      WHERE status = 'active'
        AND (${domain}::text IS NULL OR domain = ${domain})
        AND (${level}::text IS NULL OR level = ${level})
      LIMIT 100
    `;
  }

  if (topicConcepts.length === 0) {
    return {
      topic: topic || domain || "all",
      total_concepts: 0,
      matched_concepts: [],
      missed_concepts: [],
      coverage: 0,
      edge_coverage: 0,
      misconceptions_found: [],
      recommendations: ["Тема не найдена в графе понятий"],
      mastery_updated: false,
    };
  }

  const conceptIds = topicConcepts.map((c) => c.id);

  // 2. Find which concepts appear in the user text via LLM-as-judge
  // Replaces stemming (too many false positives) with precise LLM classification
  const matched: ConceptMatch[] = [];
  const missed: { code: string; name: string; centrality: number }[] = [];
  const textLower = text.toLowerCase();

  // Build concept list for LLM
  const conceptList = topicConcepts.map((c, i) => `[${i}] ${c.name}`).join("\n");

  const matchPrompt = `Определи, какие понятия из списка реально использованы или объяснены в тексте ученика.

Текст:
"""
${text.slice(0, 2000)}
"""

Понятия:
${conceptList}

Правила:
- Понятие "использовано" если ученик упоминает его (в любой форме слова) ИЛИ объясняет его суть своими словами
- НЕ считай понятие использованным если упомянуто только одно общеупотребительное слово из составного термина (например, "роль" в бытовом смысле ≠ "проектная роль")
- Будь строгим: лучше пропустить, чем ложно засчитать

Ответь JSON: {"found": [0, 3, 7], "confidence": [0.9, 0.7, 0.8]}
Если ничего не найдено: {"found": [], "confidence": []}`;

  try {
    const matchResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: matchPrompt }],
        temperature: 0.1,
        max_tokens: 300,
        response_format: { type: "json_object" },
      }),
    });

    if (matchResponse.ok) {
      const matchData = (await matchResponse.json()) as {
        choices: { message: { content: string } }[];
      };
      const parsed = JSON.parse(matchData.choices[0]?.message?.content || "{}") as {
        found: number[];
        confidence: number[];
      };

      const foundSet = new Set(parsed.found || []);
      for (let i = 0; i < topicConcepts.length; i++) {
        const concept = topicConcepts[i];
        if (foundSet.has(i)) {
          matched.push({
            code: concept.code,
            name: concept.name,
            level: concept.level,
            score: parsed.confidence?.[parsed.found.indexOf(i)] || 0.7,
          });
        } else {
          missed.push({
            code: concept.code,
            name: concept.name,
            centrality: Number(concept.similarity),
          });
        }
      }
    } else {
      // Fallback: simple full-name matching
      for (const concept of topicConcepts) {
        const conceptName = (concept.name as string).toLowerCase();
        if (textLower.includes(conceptName)) {
          matched.push({ code: concept.code, name: concept.name, level: concept.level, score: 0.9 });
        } else {
          missed.push({ code: concept.code, name: concept.name, centrality: Number(concept.similarity) });
        }
      }
    }
  } catch {
    // Fallback: simple full-name matching
    for (const concept of topicConcepts) {
      const conceptName = (concept.name as string).toLowerCase();
      if (textLower.includes(conceptName)) {
        matched.push({ code: concept.code, name: concept.name, level: concept.level, score: 0.9 });
      } else {
        missed.push({ code: concept.code, name: concept.name, centrality: Number(concept.similarity) });
      }
    }
  }

  // Sort matched by score desc, missed by centrality desc
  matched.sort((a, b) => b.score - a.score);
  missed.sort((a, b) => b.centrality - a.centrality);

  // 3. Edge coverage: how many edges between matched concepts exist
  const matchedIds = matched
    .map((m) => topicConcepts.find((c) => c.code === m.code)?.id)
    .filter(Boolean);

  let edgeCoverage = 0;
  if (matchedIds.length >= 2) {
    const edgeRows = await sql`
      SELECT COUNT(*) AS cnt
      FROM concept_graph.concept_edges
      WHERE from_concept_id = ANY(${matchedIds})
        AND to_concept_id = ANY(${matchedIds})
    `;
    const totalPossibleEdges = await sql`
      SELECT COUNT(*) AS cnt
      FROM concept_graph.concept_edges
      WHERE from_concept_id = ANY(${conceptIds})
        AND to_concept_id = ANY(${conceptIds})
    `;
    const matched_edges = Number(edgeRows[0]?.cnt || 0);
    const total_edges = Number(totalPossibleEdges[0]?.cnt || 0);
    edgeCoverage = total_edges > 0 ? matched_edges / total_edges : 0;
  }

  // 4. Check for misconceptions via LLM-as-judge (WP-208 Ф4)
  const misconceptions = await sql`
    SELECT cm.misconception_text, cm.correct_version, cm.category, cm.folk_term, c.name AS concept_name
    FROM concept_graph.concept_misconceptions cm
    JOIN concept_graph.concepts c ON c.id = cm.concept_id
    WHERE cm.concept_id = ANY(${conceptIds})
    LIMIT 30
  `;

  const foundMisconceptions: VerbalizationResult["misconceptions_found"] = [];

  if (misconceptions.length > 0 && text.length > 20) {
    // Build misconception catalog for LLM
    const miscCatalog = misconceptions.map((m, i) =>
      `[${i}] Мем: ${m.misconception_text} | Понятие: ${m.concept_name} | Тип: ${m.category}${m.correct_version ? ` | Правильно: ${m.correct_version}` : ""}${m.folk_term ? ` | Бытовой термин: ${m.folk_term}` : ""}`
    ).join("\n");

    const llmPrompt = `Ты — эксперт по выявлению подмен понятий (мемов) в текстах учеников.

Текст ученика:
"""
${text.slice(0, 2000)}
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

    try {
      const llmResponse = await fetch("https://api.openai.com/v1/chat/completions", {
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

      if (llmResponse.ok) {
        const llmData = (await llmResponse.json()) as {
          choices: { message: { content: string } }[];
        };
        const content = llmData.choices[0]?.message?.content || "{}";
        const parsed = JSON.parse(content) as { found: number[]; explanations: string[] };

        for (let i = 0; i < (parsed.found || []).length; i++) {
          const idx = parsed.found[i];
          if (idx >= 0 && idx < misconceptions.length) {
            const m = misconceptions[idx];
            foundMisconceptions.push({
              text: m.misconception_text as string,
              correct: m.correct_version as string | null,
              category: m.category as string,
              explanation: parsed.explanations?.[i] || undefined,
            });
          }
        }
      }
    } catch {
      // Fallback to simple string matching if LLM fails
      for (const m of misconceptions) {
        const miscText = (m.misconception_text as string).toLowerCase().replace(/[«»"]/g, "");
        if (miscText.length > 5 && textLower.includes(miscText.slice(0, 20).toLowerCase())) {
          foundMisconceptions.push({
            text: m.misconception_text as string,
            correct: m.correct_version as string | null,
            category: m.category as string,
          });
        }
      }
    }
  }

  // 5. Generate recommendations
  const coverage = topicConcepts.length > 0 ? matched.length / topicConcepts.length : 0;
  const recommendations: string[] = [];

  if (coverage < 0.3) {
    recommendations.push(`Покрытие понятий низкое (${Math.round(coverage * 100)}%). Проговорите больше понятий темы.`);
  }

  // Top 3 missed high-centrality concepts
  const topMissed = missed.slice(0, 3);
  for (const m of topMissed) {
    recommendations.push(`Проговорите «${m.name}» — важное понятие темы.`);
  }

  if (foundMisconceptions.length > 0) {
    recommendations.push(`Обнаружено ${foundMisconceptions.length} подмен понятий — проверьте определения.`);
  }

  if (edgeCoverage < 0.3 && matched.length >= 3) {
    recommendations.push("Понятия упомянуты, но слабо связаны между собой. Попробуйте объяснить связи.");
  }

  // 6. Update learner mastery (Ф5) — Bayesian update per matched concept
  if (userId && matched.length > 0) {
    const ALPHA = 0.3; // learning rate
    for (const m of matched) {
      const conceptRow = topicConcepts.find((c) => c.code === m.code);
      if (!conceptRow) continue;

      // Bayesian update: M_new = M_old + α * (score - M_old)
      await sql`
        INSERT INTO concept_graph.learner_concept_mastery
          (user_id, concept_id, mastery, attempts, last_score, last_assessed_at)
        VALUES (${userId}, ${conceptRow.id}, ${ALPHA * m.score}, 1, ${m.score}, NOW())
        ON CONFLICT (user_id, concept_id) DO UPDATE SET
          mastery = concept_graph.learner_concept_mastery.mastery +
            ${ALPHA} * (${m.score} - concept_graph.learner_concept_mastery.mastery),
          attempts = concept_graph.learner_concept_mastery.attempts + 1,
          last_score = ${m.score},
          last_assessed_at = NOW(),
          updated_at = NOW()
      `;
    }
  }

  return {
    topic: topic || domain || "all",
    total_concepts: topicConcepts.length,
    matched_concepts: matched.slice(0, 20),
    missed_concepts: missed.slice(0, 10),
    coverage: Math.round(coverage * 1000) / 1000,
    edge_coverage: Math.round(edgeCoverage * 1000) / 1000,
    misconceptions_found: foundMisconceptions,
    recommendations,
    mastery_updated: !!userId,
  };
}

// --- WP-242 Ф8.4: graph-as-runtime-instrument ---
// SC: DP.SC.121 / Method: DP.METHOD.042

type GraphUsageEvent = {
  query_text_hash: string;
  query_text_prefix?: string | null;
  scenario?: string | null;
  agent_id?: string | null;
  user_id_hash?: string | null;
  tool_name: string;
  seed_concept_ids?: number[];
  retrieved_concept_ids?: number[];
  edge_types_used?: string[];
  traversal_depth?: number | null;
  stale_citation_count?: number;
  misconception_as_auth_count?: number;
  mode_b_active?: boolean;
  latency_ms: number;
  fallback_reason?: string | null;
};

// PII-safe нормализация: lowercase, trim, убрать последовательности похожие на email/tg-id
function normalizeQueryForHash(query: string): string {
  return query
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\w.+-]+@[\w.-]+/g, "[email]")
    .replace(/@[a-z0-9_]{3,}/g, "[handle]")
    .replace(/\b\d{6,}\b/g, "[num]")
    .trim();
}

function safeQueryPrefix(query: string, maxLen = 40): string {
  const normalized = normalizeQueryForHash(query);
  return normalized.length <= maxLen ? normalized : normalized.slice(0, maxLen);
}

async function logGraphUsageEvent(env: Env, ev: GraphUsageEvent): Promise<void> {
  // Fire-and-forget: observability не должна ломать ответ
  try {
    const sql = db(env);
    await sql`
      INSERT INTO health.graph_usage_events (
        query_text_hash, query_text_prefix, scenario, agent_id, user_id_hash,
        tool_name, seed_concept_ids, retrieved_concept_ids, edge_types_used,
        traversal_depth, stale_citation_count, misconception_as_auth_count,
        mode_b_active, latency_ms, fallback_reason
      ) VALUES (
        ${ev.query_text_hash}, ${ev.query_text_prefix ?? null},
        ${ev.scenario ?? null}, ${ev.agent_id ?? null}, ${ev.user_id_hash ?? null},
        ${ev.tool_name},
        ${ev.seed_concept_ids ?? []}::bigint[],
        ${ev.retrieved_concept_ids ?? []}::bigint[],
        ${ev.edge_types_used ?? []}::text[],
        ${ev.traversal_depth ?? null},
        ${ev.stale_citation_count ?? 0},
        ${ev.misconception_as_auth_count ?? 0},
        ${ev.mode_b_active ?? false},
        ${ev.latency_ms},
        ${ev.fallback_reason ?? null}
      )
    `;
  } catch (err) {
    // Лог в stderr, но не бросаем — observability не должна влиять на SLA tool'а
    console.error("logGraphUsageEvent failed:", err instanceof Error ? err.message : err);
  }
}

type ConceptStatusRow = {
  id: number;
  code: string | null;
  name: string;
  status: "active" | "deprecated" | "draft" | "superseded";
  misconception: boolean;
  superseded_by: number | null;
  superseded_by_code: string | null;
  superseded_by_name: string | null;
  level: string;
  domain: string | null;
  definition: string | null;
};

async function getConceptStatus(
  env: Env,
  ref: { concept_id?: number; code?: string; name?: string }
): Promise<ConceptStatusRow | null> {
  const sql = db(env);
  let rows: ConceptStatusRow[];

  if (ref.concept_id) {
    rows = await sql`
      SELECT c.id, c.code, c.name, c.status, c.misconception, c.superseded_by,
             sb.code AS superseded_by_code, sb.name AS superseded_by_name,
             c.level, c.domain, c.definition
      FROM concept_graph.concepts c
      LEFT JOIN concept_graph.concepts sb ON sb.id = c.superseded_by
      WHERE c.id = ${ref.concept_id}
      LIMIT 1
    ` as ConceptStatusRow[];
  } else if (ref.code) {
    rows = await sql`
      SELECT c.id, c.code, c.name, c.status, c.misconception, c.superseded_by,
             sb.code AS superseded_by_code, sb.name AS superseded_by_name,
             c.level, c.domain, c.definition
      FROM concept_graph.concepts c
      LEFT JOIN concept_graph.concepts sb ON sb.id = c.superseded_by
      WHERE c.code = ${ref.code}
      LIMIT 1
    ` as ConceptStatusRow[];
  } else if (ref.name) {
    rows = await sql`
      SELECT c.id, c.code, c.name, c.status, c.misconception, c.superseded_by,
             sb.code AS superseded_by_code, sb.name AS superseded_by_name,
             c.level, c.domain, c.definition
      FROM concept_graph.concepts c
      LEFT JOIN concept_graph.concepts sb ON sb.id = c.superseded_by
      WHERE LOWER(c.name) = LOWER(${ref.name})
      ORDER BY c.status = 'active' DESC, c.id
      LIMIT 1
    ` as ConceptStatusRow[];
  } else {
    return null;
  }

  return rows[0] ?? null;
}

type ConceptSearchHit = {
  id: number;
  code: string | null;
  name: string;
  level: string;
  domain: string | null;
  status: string;
  misconception: boolean;
  similarity: number;
};

async function searchConceptByName(
  env: Env,
  name: string,
  opts: { limit?: number; include_inactive?: boolean } = {}
): Promise<ConceptSearchHit[]> {
  const sql = db(env);
  const limit = Math.min(opts.limit ?? 10, 50);

  const rows = await sql`
    SELECT c.id, c.code, c.name, c.level, c.domain, c.status, c.misconception,
           similarity(c.name, ${name}) AS similarity
    FROM concept_graph.concepts c
    WHERE c.name % ${name}
      ${opts.include_inactive ? sql`` : sql`AND c.status = 'active'`}
    ORDER BY similarity DESC, c.id
    LIMIT ${limit}
  ` as ConceptSearchHit[];

  return rows;
}

type ExpandedNeighbor = {
  id: number;
  code: string | null;
  name: string;
  status: string;
  misconception: boolean;
  level: string;
  domain: string | null;
  edge_type: string;
  edge_weight: number;
  direction: "out" | "in";
  depth: number;
};

async function expandConcept(
  env: Env,
  seedIds: number[],
  opts: {
    edge_types?: string[];
    depth?: number;
    limit?: number;
    include_inactive?: boolean;
  } = {}
): Promise<{
  neighbors: ExpandedNeighbor[];
  edges_traversed: number;
  edge_types_seen: string[];
}> {
  const sql = db(env);
  const depth = Math.min(Math.max(opts.depth ?? 1, 1), 3);
  const limit = Math.min(opts.limit ?? 20, 100);
  const edgeTypes = opts.edge_types && opts.edge_types.length > 0
    ? opts.edge_types
    : ["specializes", "part_of", "related", "prerequisite"];

  const neighbors: ExpandedNeighbor[] = [];
  const seen = new Set<number>(seedIds);
  const edgeTypesSeen = new Set<string>();
  let frontier = [...seedIds];
  let edgesTraversed = 0;
  const traversedEdgeIds: number[] = [];

  for (let d = 1; d <= depth; d++) {
    if (frontier.length === 0) break;

    const rows = await sql`
      SELECT e.id AS edge_id,
             e.from_concept_id, e.to_concept_id,
             e.edge_type, e.weight,
             fc.id AS fc_id, fc.code AS fc_code, fc.name AS fc_name,
             fc.status AS fc_status, fc.misconception AS fc_misc,
             fc.level AS fc_level, fc.domain AS fc_domain,
             tc.id AS tc_id, tc.code AS tc_code, tc.name AS tc_name,
             tc.status AS tc_status, tc.misconception AS tc_misc,
             tc.level AS tc_level, tc.domain AS tc_domain
      FROM concept_graph.concept_edges e
      JOIN concept_graph.concepts fc ON fc.id = e.from_concept_id
      JOIN concept_graph.concepts tc ON tc.id = e.to_concept_id
      WHERE (e.from_concept_id = ANY(${frontier}::bigint[])
          OR e.to_concept_id = ANY(${frontier}::bigint[]))
        AND e.edge_type = ANY(${edgeTypes}::text[])
        ${opts.include_inactive ? sql`` : sql`AND fc.status = 'active' AND tc.status = 'active'`}
    ` as Array<{
      edge_id: number;
      from_concept_id: number;
      to_concept_id: number;
      edge_type: string;
      weight: number;
      fc_id: number; fc_code: string | null; fc_name: string; fc_status: string; fc_misc: boolean; fc_level: string; fc_domain: string | null;
      tc_id: number; tc_code: string | null; tc_name: string; tc_status: string; tc_misc: boolean; tc_level: string; tc_domain: string | null;
    }>;

    const nextFrontier: number[] = [];
    const frontierSet = new Set(frontier);

    for (const r of rows) {
      edgesTraversed++;
      edgeTypesSeen.add(r.edge_type);
      traversedEdgeIds.push(r.edge_id);

      const isFromInFrontier = frontierSet.has(r.from_concept_id);
      const otherId = isFromInFrontier ? r.to_concept_id : r.from_concept_id;

      if (seen.has(otherId)) continue;
      seen.add(otherId);

      const n: ExpandedNeighbor = isFromInFrontier
        ? {
            id: r.tc_id, code: r.tc_code, name: r.tc_name,
            status: r.tc_status, misconception: r.tc_misc,
            level: r.tc_level, domain: r.tc_domain,
            edge_type: r.edge_type, edge_weight: r.weight,
            direction: "out", depth: d,
          }
        : {
            id: r.fc_id, code: r.fc_code, name: r.fc_name,
            status: r.fc_status, misconception: r.fc_misc,
            level: r.fc_level, domain: r.fc_domain,
            edge_type: r.edge_type, edge_weight: r.weight,
            direction: "in", depth: d,
          };

      neighbors.push(n);
      nextFrontier.push(otherId);
    }

    frontier = nextFrontier;
    if (neighbors.length >= limit) break;
  }

  // Обновляем last_traversed_at на пройденных рёбрах (fire-and-forget)
  if (traversedEdgeIds.length > 0) {
    try {
      await sql`
        UPDATE concept_graph.concept_edges
        SET last_traversed_at = NOW()
        WHERE id = ANY(${traversedEdgeIds}::bigint[])
      `;
    } catch (err) {
      console.error("update last_traversed_at failed:", err instanceof Error ? err.message : err);
    }
  }

  // Сортировка: по глубине, затем по весу
  neighbors.sort((a, b) => a.depth - b.depth || b.edge_weight - a.edge_weight);

  return {
    neighbors: neighbors.slice(0, limit),
    edges_traversed: edgesTraversed,
    edge_types_seen: Array.from(edgeTypesSeen),
  };
}

// --- WP-208: graph_stats ---

async function getGraphStats(env: Env) {
  const sql = db(env);

  const [conceptCount] = await sql`SELECT COUNT(*)::int AS cnt FROM concept_graph.concepts WHERE status = 'active'`;
  const [edgeCount] = await sql`SELECT COUNT(*)::int AS cnt FROM concept_graph.concept_edges`;
  const [miscCount] = await sql`SELECT COUNT(*)::int AS cnt FROM concept_graph.concept_misconceptions`;

  const byLevel = await sql`
    SELECT level, COUNT(*)::int AS cnt
    FROM concept_graph.concepts WHERE status = 'active'
    GROUP BY level ORDER BY cnt DESC
  `;

  const byEdgeType = await sql`
    SELECT edge_type, COUNT(*)::int AS cnt
    FROM concept_graph.concept_edges
    GROUP BY edge_type ORDER BY cnt DESC
  `;

  const orphans = await sql`
    SELECT c.code, c.name, c.level
    FROM concept_graph.concepts c
    LEFT JOIN concept_graph.concept_edges e1 ON e1.from_concept_id = c.id
    LEFT JOIN concept_graph.concept_edges e2 ON e2.to_concept_id = c.id
    WHERE c.status = 'active' AND e1.id IS NULL AND e2.id IS NULL
    LIMIT 20
  `;

  // Suspicious edges (АрхГейт L2.2 mitigation)
  const suspiciousEdges = await sql`
    SELECT c1.code AS from_code, c1.name AS from_name,
           c2.code AS to_code, c2.name AS to_name,
           e.weight, e.weight_source
    FROM concept_graph.concept_edges e
    JOIN concept_graph.concepts c1 ON c1.id = e.from_concept_id
    JOIN concept_graph.concepts c2 ON c2.id = e.to_concept_id
    WHERE e.edge_type = 'specializes'
      AND e.weight_source = 'embedding'
      AND e.weight < 0.8
    LIMIT 20
  `;

  const topCentral = await sql`
    SELECT c.code, c.name, COUNT(*)::int AS connections
    FROM concept_graph.concepts c
    LEFT JOIN concept_graph.concept_edges e ON e.from_concept_id = c.id OR e.to_concept_id = c.id
    WHERE c.status = 'active'
    GROUP BY c.id, c.code, c.name
    ORDER BY connections DESC
    LIMIT 10
  `;

  return {
    concepts: conceptCount.cnt,
    edges: edgeCount.cnt,
    misconceptions: miscCount.cnt,
    by_level: byLevel,
    by_edge_type: byEdgeType,
    orphans: orphans.length > 0 ? orphans : "none",
    suspicious_edges: suspiciousEdges.length > 0 ? suspiciousEdges : "none",
    top_central: topCentral,
  };
}

// --- WP-208 Ф5: learner_progress ---

async function getLearnerProgress(env: Env, userId: string, domain: string | undefined) {
  const sql = db(env);

  // Overall stats
  const [totalConcepts] = await sql`
    SELECT COUNT(*)::int AS cnt FROM concept_graph.concepts
    WHERE status = 'active' AND (${domain}::text IS NULL OR domain = ${domain})
  `;
  const [masteredCount] = await sql`
    SELECT COUNT(*)::int AS cnt FROM concept_graph.learner_concept_mastery lm
    JOIN concept_graph.concepts c ON c.id = lm.concept_id
    WHERE lm.user_id = ${userId} AND lm.mastery >= 0.5
      AND (${domain}::text IS NULL OR c.domain = ${domain})
  `;
  const [totalAttempts] = await sql`
    SELECT COALESCE(SUM(attempts), 0)::int AS cnt FROM concept_graph.learner_concept_mastery
    WHERE user_id = ${userId}
  `;

  // Per-domain breakdown
  const byDomain = await sql`
    SELECT c.domain,
           COUNT(DISTINCT c.id)::int AS total_concepts,
           COUNT(DISTINCT lm.concept_id) FILTER (WHERE lm.mastery >= 0.5)::int AS mastered,
           ROUND(AVG(lm.mastery)::numeric, 2) AS avg_mastery
    FROM concept_graph.concepts c
    LEFT JOIN concept_graph.learner_concept_mastery lm
      ON lm.concept_id = c.id AND lm.user_id = ${userId}
    WHERE c.status = 'active' AND c.domain IS NOT NULL
      AND (${domain}::text IS NULL OR c.domain = ${domain})
    GROUP BY c.domain
    ORDER BY total_concepts DESC
  `;

  // Top mastered concepts
  const topMastered = await sql`
    SELECT c.code, c.name, c.level, lm.mastery, lm.attempts, lm.last_assessed_at
    FROM concept_graph.learner_concept_mastery lm
    JOIN concept_graph.concepts c ON c.id = lm.concept_id
    WHERE lm.user_id = ${userId}
      AND (${domain}::text IS NULL OR c.domain = ${domain})
    ORDER BY lm.mastery DESC
    LIMIT 10
  `;

  // Weakest concepts (assessed but low mastery)
  const weakest = await sql`
    SELECT c.code, c.name, c.level, lm.mastery, lm.attempts
    FROM concept_graph.learner_concept_mastery lm
    JOIN concept_graph.concepts c ON c.id = lm.concept_id
    WHERE lm.user_id = ${userId} AND lm.mastery < 0.5 AND lm.attempts >= 1
      AND (${domain}::text IS NULL OR c.domain = ${domain})
    ORDER BY lm.mastery ASC
    LIMIT 10
  `;

  // Recommended next concepts (high centrality, not yet assessed)
  const recommended = await sql`
    SELECT c.code, c.name, c.level, c.domain,
           COUNT(e.id)::int AS connections
    FROM concept_graph.concepts c
    LEFT JOIN concept_graph.concept_edges e ON e.from_concept_id = c.id OR e.to_concept_id = c.id
    LEFT JOIN concept_graph.learner_concept_mastery lm ON lm.concept_id = c.id AND lm.user_id = ${userId}
    WHERE c.status = 'active' AND lm.id IS NULL
      AND c.level IN ('guide', 'pack')
      AND (${domain}::text IS NULL OR c.domain = ${domain})
    GROUP BY c.id, c.code, c.name, c.level, c.domain
    ORDER BY connections DESC
    LIMIT 5
  `;

  return {
    user_id: userId,
    domain: domain || "all",
    total_concepts: totalConcepts.cnt,
    mastered: masteredCount.cnt,
    coverage: totalConcepts.cnt > 0 ? Math.round(masteredCount.cnt / totalConcepts.cnt * 1000) / 1000 : 0,
    total_attempts: totalAttempts.cnt,
    by_domain: byDomain,
    top_mastered: topMastered,
    weakest: weakest,
    recommended_next: recommended,
  };
}

// --- MCP tool definitions ---

const TOOLS = [
  {
    name: "search",
    description:
      "Hybrid search across knowledge base documents with LLM reranking. Searches Pack entities, guides, and DS knowledge. Uses keyword search for entity codes (e.g. DP.AGENT.001) and semantic vector search with LLM reranking for natural language queries. Returns parent document content when available for chunked documents.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query text" },
        source: {
          type: "string",
          description: "Filter by specific source (e.g., 'PACK-digital-platform')",
        },
        source_type: {
          type: "string",
          enum: ["pack", "guides", "ds", "content"],
          description: "Filter by source type: pack (domain knowledge), guides (educational), ds (processes), content (posts/articles)",
        },
        limit: { type: "number", description: "Maximum number of results (default: 5)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_document",
    description: "Get a specific document by filename",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Document filename (relative path)" },
        source: { type: "string", description: "Source name to disambiguate" },
      },
      required: ["filename"],
    },
  },
  {
    name: "list_sources",
    description: "List all available knowledge sources with document counts",
    inputSchema: {
      type: "object",
      properties: {
        source_type: {
          type: "string",
          enum: ["pack", "guides", "ds"],
          description: "Filter by source type",
        },
      },
    },
  },
  {
    name: "knowledge_feedback",
    description:
      "Record helpfulness feedback for a retrieved document. Call after using a search result to signal whether it was actually helpful. This data improves future retrieval quality.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "number", description: "ID of the document from search results" },
        query: { type: "string", description: "Original search query that returned this document" },
        helpfulness: { type: "boolean", description: "true if document was helpful, false otherwise" },
      },
      required: ["document_id", "query", "helpfulness"],
    },
  },
  {
    name: "feedback_stats",
    description:
      "Analytics: top documents by helpfulness feedback over a period. Shows which documents are actually used by agents.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Period in days (default: 30)" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
  },
  {
    name: "analyze_verbalization",
    description:
      "Анализирует текст пользователя (ДЗ, эссе, проговаривание) на предмет использования понятий из графа знаний. Возвращает: покрытие понятий, пропущенные ключевые понятия, связность, обнаруженные мемы/подмены, рекомендации. Используй для оценки качества проговаривания или письменной работы.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Текст пользователя для анализа (ДЗ, эссе, проговаривание)" },
        topic: { type: "string", description: "Тема/раздел для сравнения (например, 'Роли и мастерство', 'Собранность'). Если не указано — анализ по всему графу" },
        domain: { type: "string", description: "Фильтр по домену: MIM, DP, PD, ECO и т.д." },
        level: { type: "string", enum: ["zp", "fpf", "pack", "guide", "course"], description: "Фильтр по уровню иерархии знаний" },
        user_id: { type: "string", description: "Ory user UUID — если передан, обновляет mastery ученика по результатам анализа" },
      },
      required: ["text"],
    },
  },
  {
    name: "graph_stats",
    description:
      "Статистика графа понятий: количество понятий по уровням, связи по типам, orphan-понятия (без связей), подозрительные edges для ревью, топ-10 центральных понятий.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "learner_progress",
    description:
      "Прогресс ученика по освоению понятий: общее покрытие, разбивка по доменам, топ освоенных, слабые места, рекомендации что учить дальше. Данные обновляются при каждом вызове analyze_verbalization с user_id.",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "Ory user UUID" },
        domain: { type: "string", description: "Фильтр по домену (MIM, PD, DP и т.д.)" },
      },
      required: ["user_id"],
    },
  },
  {
    name: "knowledge_concept_status",
    description:
      "Возвращает статус концепта (active/deprecated/draft/superseded), признак misconception, и ссылку superseded_by, если концепт заменён новым. Используй перед тем как цитировать концепт в ответе, чтобы соответствовать DP.SC.121 mode (a) — не ссылаться на устаревшие/заблуждения.",
    inputSchema: {
      type: "object",
      properties: {
        concept_id: { type: "number", description: "id концепта (priority 1)" },
        code: { type: "string", description: "code концепта, например 'DP.SC.121' или 'MIM.FMT.001'" },
        name: { type: "string", description: "имя концепта (поиск exact lowercase)" },
      },
    },
  },
  {
    name: "knowledge_concept_search_by_name",
    description:
      "Fuzzy-поиск концепта по имени (trigram). Для сценариев: (1) разрешить естественное имя в id; (2) проверить наличие концепта перед цитированием. Возвращает top-N с similarity, status, misconception. Отличается от 'search' тем, что работает только по полю name графа, а не по embed'ам документов.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Имя концепта для поиска (подстрока ок)" },
        limit: { type: "number", description: "Макс. результатов (default: 10, max: 50)" },
        include_inactive: { type: "boolean", description: "Включать deprecated/superseded (default: false)" },
      },
      required: ["name"],
    },
  },
  {
    name: "knowledge_concept_expand",
    description:
      "BFS-обход графа от seed-концептов: возвращает соседей через рёбра specializes/part_of/related/prerequisite. Используй когда пользователь задал термин и тебе нужны связанные понятия для развёрнутого ответа (DP.METHOD.042 сценарии: определение, Pack-обучение, онтологические ответы). Автоматически фильтрует deprecated/superseded в выдаче. Обновляет last_traversed_at на пройденных рёбрах.",
    inputSchema: {
      type: "object",
      properties: {
        concept_id: { type: "number", description: "id seed-концепта (альтернатива concept_ids/code)" },
        concept_ids: { type: "array", items: { type: "number" }, description: "Массив seed id (BFS из нескольких точек)" },
        code: { type: "string", description: "code seed-концепта, напр. 'DP.SC.121'" },
        edge_types: {
          type: "array",
          items: { type: "string", enum: ["specializes", "part_of", "related", "prerequisite", "contradicts"] },
          description: "Какие типы рёбер обходить. Default: specializes+part_of+related+prerequisite",
        },
        depth: { type: "number", description: "Глубина BFS (1-3, default 1)" },
        limit: { type: "number", description: "Макс. соседей в ответе (default 20, max 100)" },
        scenario: {
          type: "string",
          enum: ["claude-code", "pack-author", "portnoy", "ocenshik", "navigator", "learning-trajectory"],
          description: "Сценарий использования (для observability)",
        },
      },
    },
  },
];

// --- MCP handler ---

async function handleMcpRequest(request: McpRequest, env: Env, userId?: string): Promise<McpResponse> {
  const { id, method, params } = request;

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "knowledge-mcp", version: "4.1.0" },
          },
        };

      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

      case "tools/call": {
        const toolName = (params as { name: string }).name;
        const args = (params as { arguments: Record<string, unknown> }).arguments || {};

        if (toolName === "search") {
          const results = await searchDocuments(
            env,
            args.query as string,
            args.source as string | undefined,
            args.source_type as string | undefined,
            (args.limit as number) || 5,
            userId
          );
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] },
          };
        }

        if (toolName === "get_document") {
          const doc = await getDocument(env, args.filename as string, args.source as string | undefined, userId);
          if (!doc) {
            return {
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: "Document not found" }], isError: true },
            };
          }
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: doc.content }] },
          };
        }

        if (toolName === "list_sources") {
          const sources = await listSources(env, args.source_type as string | undefined, userId);
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(sources, null, 2) }] },
          };
        }

        if (toolName === "knowledge_feedback") {
          const result = await recordFeedback(
            env,
            args.document_id as number,
            args.query as string,
            args.helpfulness as boolean
          );
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(result) }] },
          };
        }

        if (toolName === "feedback_stats") {
          const stats = await getFeedbackStats(env, (args.days as number) || 30, (args.limit as number) || 20, userId);
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] },
          };
        }

        if (toolName === "analyze_verbalization") {
          const result = await analyzeVerbalization(
            env,
            args.text as string,
            args.topic as string | undefined,
            args.domain as string | undefined,
            args.level as string | undefined,
            args.user_id as string | undefined
          );
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
          };
        }

        if (toolName === "graph_stats") {
          const stats = await getGraphStats(env);
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] },
          };
        }

        if (toolName === "learner_progress") {
          const progress = await getLearnerProgress(
            env,
            args.user_id as string,
            args.domain as string | undefined
          );
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(progress, null, 2) }] },
          };
        }

        // --- WP-242 Ф8.4 tools ---

        if (toolName === "knowledge_concept_status") {
          const t0 = Date.now();
          const concept = await getConceptStatus(env, {
            concept_id: args.concept_id as number | undefined,
            code: args.code as string | undefined,
            name: args.name as string | undefined,
          });
          const latency = Date.now() - t0;

          const queryText = (args.code as string) || (args.name as string) || String(args.concept_id ?? "");
          const queryHash = await hashQuery(normalizeQueryForHash(queryText));
          await logGraphUsageEvent(env, {
            query_text_hash: queryHash,
            query_text_prefix: safeQueryPrefix(queryText),
            tool_name: "knowledge_concept_status",
            agent_id: null,
            seed_concept_ids: concept ? [concept.id] : [],
            retrieved_concept_ids: concept ? [concept.id] : [],
            traversal_depth: 0,
            latency_ms: latency,
            fallback_reason: concept ? null : "empty_result",
          });

          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(concept ?? { not_found: true }, null, 2) }],
            },
          };
        }

        if (toolName === "knowledge_concept_search_by_name") {
          const t0 = Date.now();
          const name = args.name as string;
          const hits = await searchConceptByName(env, name, {
            limit: args.limit as number | undefined,
            include_inactive: args.include_inactive as boolean | undefined,
          });
          const latency = Date.now() - t0;

          const queryHash = await hashQuery(normalizeQueryForHash(name));
          await logGraphUsageEvent(env, {
            query_text_hash: queryHash,
            query_text_prefix: safeQueryPrefix(name),
            tool_name: "knowledge_concept_search_by_name",
            seed_concept_ids: [],
            retrieved_concept_ids: hits.map((h) => h.id),
            traversal_depth: 0,
            latency_ms: latency,
            fallback_reason: hits.length === 0 ? "empty_result" : null,
          });

          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(hits, null, 2) }] },
          };
        }

        if (toolName === "knowledge_concept_expand") {
          const t0 = Date.now();

          // Resolve seed(s)
          let seedIds: number[] = [];
          if (Array.isArray(args.concept_ids)) {
            seedIds = (args.concept_ids as number[]).filter((x) => typeof x === "number");
          } else if (typeof args.concept_id === "number") {
            seedIds = [args.concept_id];
          } else if (typeof args.code === "string") {
            const c = await getConceptStatus(env, { code: args.code });
            if (c) seedIds = [c.id];
          }

          if (seedIds.length === 0) {
            const latency = Date.now() - t0;
            const queryText = (args.code as string) || JSON.stringify(args.concept_ids ?? args.concept_id ?? "");
            const queryHash = await hashQuery(normalizeQueryForHash(queryText));
            await logGraphUsageEvent(env, {
              query_text_hash: queryHash,
              query_text_prefix: safeQueryPrefix(queryText),
              tool_name: "knowledge_concept_expand",
              scenario: (args.scenario as string | undefined) ?? null,
              seed_concept_ids: [],
              retrieved_concept_ids: [],
              traversal_depth: 0,
              latency_ms: latency,
              fallback_reason: "empty_result",
            });
            return {
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: JSON.stringify({ neighbors: [], reason: "seed not resolved" }) }] },
            };
          }

          const result = await expandConcept(env, seedIds, {
            edge_types: args.edge_types as string[] | undefined,
            depth: args.depth as number | undefined,
            limit: args.limit as number | undefined,
          });
          const latency = Date.now() - t0;

          const queryText = (args.code as string) || JSON.stringify(seedIds);
          const queryHash = await hashQuery(normalizeQueryForHash(queryText));
          await logGraphUsageEvent(env, {
            query_text_hash: queryHash,
            query_text_prefix: safeQueryPrefix(queryText),
            tool_name: "knowledge_concept_expand",
            scenario: (args.scenario as string | undefined) ?? null,
            seed_concept_ids: seedIds,
            retrieved_concept_ids: result.neighbors.map((n) => n.id),
            edge_types_used: result.edge_types_seen,
            traversal_depth: (args.depth as number | undefined) ?? 1,
            latency_ms: latency,
            fallback_reason: result.neighbors.length === 0 ? "empty_result" : null,
          });

          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      seeds: seedIds,
                      neighbors: result.neighbors,
                      edges_traversed: result.edges_traversed,
                      edge_types_seen: result.edge_types_seen,
                    },
                    null,
                    2
                  ),
                },
              ],
            },
          };
        }

        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${toolName}` } };
      }

      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: err instanceof Error ? err.message : "Unknown error" },
    };
  }
}

// --- Reindex helpers ---

async function contentHash(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/**
 * Read file from GitHub public API (no auth needed for public repos).
 * Falls back to raw.githubusercontent.com for speed.
 */
async function readFromGitHubPublic(source: string, filePath: string): Promise<string | null> {
  const config = SOURCE_GITHUB_BASE[source];
  if (!config) return null;

  // Extract owner/repo from base URL: https://github.com/OWNER/REPO/blob/BRANCH
  const match = config.base.match(/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)/);
  if (!match) return null;

  const [, owner, repo, branch] = match;
  // filePath from webhook already contains full path from repo root (e.g. "pack/digital-platform/...")
  // Do NOT prepend pathPrefix — it would cause duplication (e.g. "pack/pack/...")
  const fullPath = filePath;

  const resp = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${fullPath}`, {
    headers: { "User-Agent": "aisystant-knowledge-mcp" },
  });

  if (!resp.ok) return null;
  return await resp.text();
}

/**
 * Resolve source_type from SOURCE_GITHUB_BASE source name.
 */
function resolveSourceType(source: string): "pack" | "guides" | "ds" | "content" {
  if (source.startsWith("PACK-")) return "pack";
  if (source.startsWith("DS-")) return "ds";
  if (source === "SPF" || source === "FPF" || source === "ZP") return "pack";
  if (source.startsWith("docs-") || source.endsWith("-docs")) return "guides";
  if (source.startsWith("FMT-")) return "ds";
  return "ds";
}

/**
 * Chunk large file by ## / ### headers / paragraphs.
 * Matches ingest.ts chunkLargeFile() logic for consistency.
 */
function chunkLargeFile(content: string, filename: string): { filename: string; content: string }[] {
  const chunks: { filename: string; content: string }[] = [];

  const titleMatch = content.match(/^#\s+(.+)/m);
  const docTitle = titleMatch ? titleMatch[1].trim() : "";

  const sections = content.split(/^(?=## )/m);

  for (const section of sections) {
    if (section.trim().length < 10) continue;

    const headerMatch = section.match(/^##\s+(.+)/m);
    const sectionName = headerMatch ? headerMatch[1].trim() : "_intro";

    if (section.length <= CHUNK_CHAR_LIMIT) {
      const prefix = docTitle ? `> ${docTitle} > ${sectionName}\n\n` : "";
      chunks.push({ filename: `${filename}::${sectionName}`, content: prefix + section });
    } else {
      const subsections = section.split(/^(?=### )/m);
      for (const subsection of subsections) {
        if (subsection.trim().length < 10) continue;
        const subMatch = subsection.match(/^###\s+(.+)/m);
        const subName = subMatch ? `${sectionName} > ${subMatch[1].trim()}` : sectionName;

        if (subsection.length <= CHUNK_CHAR_LIMIT) {
          const prefix = docTitle ? `> ${docTitle} > ${subName}\n\n` : "";
          chunks.push({ filename: `${filename}::${subName}`, content: prefix + subsection });
        } else {
          const paragraphs = subsection.split(/\n\n+/);
          let accumulator = "";
          let partIndex = 0;
          for (const para of paragraphs) {
            if (accumulator.length + para.length + 2 > CHUNK_CHAR_LIMIT && accumulator.length > 0) {
              const prefix = docTitle ? `> [${filename.split("::")[0]}] ${docTitle} > ${subName} (part ${++partIndex})\n\n` : "";
              chunks.push({ filename: `${filename}::${subName}::part${partIndex}`, content: prefix + accumulator.trim() });
              accumulator = "";
            }
            accumulator += (accumulator ? "\n\n" : "") + para;
          }
          if (accumulator.trim().length >= 10) {
            if (partIndex > 0) {
              const prefix = docTitle ? `> [${filename.split("::")[0]}] ${docTitle} > ${subName} (part ${++partIndex})\n\n` : "";
              chunks.push({ filename: `${filename}::${subName}::part${partIndex}`, content: prefix + accumulator.trim() });
            } else {
              const prefix = docTitle ? `> ${docTitle} > ${subName}\n\n` : "";
              chunks.push({ filename: `${filename}::${subName}`, content: prefix + accumulator.trim() });
            }
          }
        }
      }
    }
  }

  return chunks;
}

/**
 * Reindex specific files from a platform knowledge source.
 * Called by Gateway webhook after push to PACK, SPF, FPF repos.
 * Reads files from GitHub public API, chunks, embeds, upserts to Neon.
 */
async function reindexFiles(env: Env, req: ReindexRequest): Promise<{ processed: number; deleted: number; skipped: number; errors: string[] }> {
  const sql = db(env);
  const result = { processed: 0, deleted: 0, skipped: 0, errors: [] as string[] };

  if (!SOURCE_GITHUB_BASE[req.source]) {
    result.errors.push(`Unknown source: ${req.source}. Known sources: ${Object.keys(SOURCE_GITHUB_BASE).join(", ")}`);
    return result;
  }

  // Resolve user_id: L2 platform → NULL (visible to all). L4 personal → user_sources.user_id (required).
  // WP-268: user_sources перенесён в новую `knowledge` БД через mvp/016 (DDL+ETL).
  const isL2 = L2_PLATFORM_SOURCES.has(req.source);
  const userRows = await sql`SELECT user_id FROM user_sources WHERE source = ${req.source} LIMIT 1`;

  if (isL2 && userRows.length > 0) {
    result.errors.push(`Conflict: ${req.source} is L2 platform but registered in user_sources`);
    return result;
  }
  if (!isL2 && userRows.length === 0) {
    result.errors.push(`Unregistered L4 source: ${req.source}. Add to user_sources or L2_PLATFORM_SOURCES.`);
    return result;
  }

  const uid = isL2 ? null : (userRows[0].user_id as string);

  const sourceType = resolveSourceType(req.source);
  const sourceConfig = SOURCE_GITHUB_BASE[req.source];
  const pathPrefix = sourceConfig?.pathPrefix || "";

  for (const file of req.files) {
    if (!file.path.endsWith(".md")) {
      result.skipped++;
      continue;
    }

    // Normalize: strip pathPrefix from webhook path to match ingest.ts filenames in DB.
    // Webhook sends "pack/digital-platform/..." but DB stores "digital-platform/..."
    const dbFilename = pathPrefix && file.path.startsWith(pathPrefix)
      ? file.path.slice(pathPrefix.length)
      : file.path;

    // WP-268 cut-over notes для INSERT в knowledge_chunk:
    //  - collection_kind: 'platform' (uid IS NULL) | 'personal' (uid != NULL)
    //  - account_id: UUID (cast from uid TEXT). Для platform — NULL.
    //  - source_uri = legacy filename
    //  - source_kind = legacy source_type
    //  - search_vector — generated stored, не передаём
    //  - Уникальность для ON CONFLICT: idx_kc_source_account (source_uri, source, COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid))
    //    создаётся в mvp/016 одновременно с retrieval_feedback DDL.
    const collectionKind = uid ? 'personal' : 'platform';
    const accountUuid = uid; // pg cast TEXT→UUID при подстановке параметра
    try {
      if (file.action === "removed") {
        await sql`DELETE FROM knowledge_chunk WHERE source = ${req.source} AND (source_uri = ${dbFilename} OR source_uri LIKE ${dbFilename + '::%'})`;
        result.deleted++;
        continue;
      }

      // Read content from GitHub public API (use full path from repo root)
      const content = await readFromGitHubPublic(req.source, file.path);
      if (!content) {
        result.errors.push(`Cannot read ${file.path} from GitHub for source ${req.source}`);
        continue;
      }

      if (content.length > MAX_FILE_SIZE) {
        result.skipped++;
        continue;
      }

      // Check hash — skip if unchanged
      const hash = await contentHash(content);
      const existing = await sql`SELECT hash FROM knowledge_chunk WHERE source_uri = ${dbFilename} AND source = ${req.source} LIMIT 1`;
      if (existing.length > 0 && existing[0].hash === hash) {
        result.skipped++;
        continue;
      }

      // Delete old document + chunks
      await sql`DELETE FROM knowledge_chunk WHERE source = ${req.source} AND (source_uri = ${dbFilename} OR source_uri LIKE ${dbFilename + '::%'})`;

      if (content.length > LARGE_FILE_THRESHOLD) {
        // Large file: parent document (no embedding) + chunks with parent_chunk_id
        const chunks = chunkLargeFile(content, dbFilename);

        // Insert parent document (no embedding). search_vector — generated stored.
        await sql`
          INSERT INTO knowledge_chunk
            (source_uri, content, source, source_kind, hash, embedding, account_id, collection_kind)
          VALUES
            (${dbFilename}, ${content}, ${req.source}, ${sourceType}, ${hash}, NULL,
             ${accountUuid}::uuid, ${collectionKind})
          ON CONFLICT (source_uri, source, COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid))
            DO NOTHING
        `;

        // Insert chunks with embeddings, link via parent_chunk_id (UUID self-FK)
        for (const chunk of chunks) {
          const embedding = await getEmbedding(env.OPENAI_API_KEY, chunk.content.slice(0, CHUNK_CHAR_LIMIT));
          const vec = `[${embedding.join(",")}]`;
          const chunkHash = await contentHash(chunk.content);

          await sql`
            INSERT INTO knowledge_chunk
              (source_uri, content, source, source_kind, hash, embedding, parent_chunk_id, account_id, collection_kind)
            VALUES (
              ${chunk.filename}, ${chunk.content}, ${req.source}, ${sourceType}, ${chunkHash},
              ${vec}::vector,
              (SELECT chunk_uuid FROM knowledge_chunk WHERE source_uri = ${dbFilename} AND source = ${req.source} LIMIT 1),
              ${accountUuid}::uuid, ${collectionKind}
            )
            ON CONFLICT (source_uri, source, COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid))
              DO NOTHING
          `;
        }
      } else {
        // Small file: single document with embedding
        const embedding = await getEmbedding(env.OPENAI_API_KEY, content.slice(0, CHUNK_CHAR_LIMIT));
        const vec = `[${embedding.join(",")}]`;

        await sql`
          INSERT INTO knowledge_chunk
            (source_uri, content, source, source_kind, hash, embedding, account_id, collection_kind)
          VALUES
            (${dbFilename}, ${content}, ${req.source}, ${sourceType}, ${hash}, ${vec}::vector,
             ${accountUuid}::uuid, ${collectionKind})
          ON CONFLICT (source_uri, source, COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid))
            DO NOTHING
        `;
      }

      result.processed++;
    } catch (err) {
      result.errors.push(`${file.path}: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  return result;
}

// --- HTTP server ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-trace-id",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/mcp" && request.method === "POST") {
      const traceId = request.headers.get("x-trace-id") || undefined;

      // JWT verification (B4.21): verify Bearer token locally.
      // If Authorization header is present → MUST be a valid JWT; no x-user-id fallback
      // (prevents spoofing userId with an expired/invalid token + custom x-user-id).
      // If no Authorization header → fall back to x-user-id for internal/platform requests
      // (e.g. reindexer calls that don't carry a user token).
      let userId: string | undefined;
      const authHeader = request.headers.get("Authorization");
      if (authHeader?.startsWith("Bearer ") && env.ORY_URL) {
        const token = authHeader.slice(7);
        const sub = await verifyJwtLocally(env.ORY_URL, token);
        userId = sub ?? undefined;
        // Note: opaque tokens (from Gateway /userinfo flow) return null sub → userId=undefined,
        // treated as unauthenticated. Gateway should only forward JWTs to knowledge-mcp.
      } else {
        userId = request.headers.get("x-user-id") || undefined;
      }

      const body = (await request.json()) as McpRequest;
      const response = await handleMcpRequest(body, env, userId);
      const responseHeaders: Record<string, string> = {
        ...corsHeaders,
        "Content-Type": "application/json",
      };
      if (traceId) {
        responseHeaders["x-trace-id"] = traceId;
      }
      return new Response(JSON.stringify(response), {
        headers: responseHeaders,
      });
    }

    // Reindex endpoint — called by Gateway webhook handler after push to platform repos
    if (url.pathname === "/reindex" && request.method === "POST") {
      // Verify shared secret
      if (env.REINDEX_SECRET) {
        const auth = request.headers.get("Authorization");
        if (!auth || auth !== `Bearer ${env.REINDEX_SECRET}`) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
      const body = (await request.json()) as ReindexRequest;
      const result = await reindexFiles(env, body);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/health") {
      return new Response("OK", { headers: corsHeaders });
    }

    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          name: "Knowledge MCP Server",
          version: "4.1.0",
          description: "Hybrid MCP — OpenAI Embeddings + Neon pgvector + pg_trgm + LLM Reranking + Parent Retrieval",
          mcp_endpoint: "/mcp",
          tools: TOOLS.map((t) => t.name),
          source_types: ["pack", "guides", "ds", "content"],
        }),
        { headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};
