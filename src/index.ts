/**
 * Knowledge MCP Server v4.0 — L2 Platform — Hybrid Search + Parent Retrieval + LLM Reranking
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

// --- Types ---

interface Env {
  DATABASE_URL: string;
  OPENAI_API_KEY: string;
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

// --- Config ---

const EMBEDDING_MODEL = "text-embedding-3-small";
const VECTOR_CONFIDENCE_THRESHOLD = 0.6;
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
  "DS-autonomous-agents": { base: "https://github.com/aisystant/DS-autonomous-agents/blob/main", pathPrefix: "" },
  "PACK-verification": { base: "https://github.com/aisystant/PACK-verification/blob/main", pathPrefix: "pack/" },
  "PACK-autonomous-agents": { base: "https://github.com/aisystant/PACK-autonomous-agents/blob/main", pathPrefix: "pack/" },
  "PACK-ecosystem": { base: "https://github.com/aisystant/PACK-ecosystem/blob/main", pathPrefix: "pack/" },
};

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
  return neon(env.DATABASE_URL);
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

type SearchResult = {
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
  limit: number = 5
): Promise<SearchResult[]> {
  const sql = db(env);
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

  const rows = await sql`
    SELECT filename, content, source, source_type,
           CASE
             WHEN filename ILIKE ${pattern} THEN 1.0
             WHEN ${entityPattern}::text IS NOT NULL
                  AND filename ILIKE ${entityPattern}
                  AND ${sectionPattern}::text IS NOT NULL
                  AND content ILIKE ${sectionPattern} THEN 0.98
             WHEN filename ILIKE ${entityPattern} AND ${entityPattern}::text IS NOT NULL THEN 0.95
             WHEN content ILIKE ${pattern} THEN 0.90
             WHEN search_vector @@ plainto_tsquery('simple', ${ftsQuery}) THEN 0.8
             ELSE 0.5
           END AS score
    FROM documents
    WHERE embedding IS NOT NULL
      AND (content ILIKE ${pattern}
           OR filename ILIKE ${pattern}
           OR search_vector @@ plainto_tsquery('simple', ${ftsQuery})
           OR (${entityPattern}::text IS NOT NULL AND filename ILIKE ${entityPattern}))
      AND (${src}::text IS NULL OR source = ${src})
      AND (${stype}::text IS NULL OR source_type = ${stype})
    ORDER BY score DESC,
             CASE WHEN filename ILIKE ${pattern} THEN 0 ELSE 1 END,
             length(content) DESC
    LIMIT ${limit}
  `;

  return rows.map((r) => {
    const source = (r.source as string) || "";
    const filename = r.filename as string;
    return {
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
  limit: number = 5
): Promise<SearchResult[]> {
  const embedding = await getEmbedding(env.OPENAI_API_KEY, query);
  const vec = `[${embedding.join(",")}]`;
  const sql = db(env);
  const src = source ?? null;
  const stype = sourceType ?? null;

  const rows = await sql`
    SELECT filename, content, source, source_type,
           1 - (embedding <=> ${vec}::vector) AS score
    FROM documents
    WHERE embedding IS NOT NULL
      AND (${src}::text IS NULL OR source = ${src})
      AND (${stype}::text IS NULL OR source_type = ${stype})
    ORDER BY embedding <=> ${vec}::vector
    LIMIT ${limit}
  `;

  return rows.map((r) => {
    const source = (r.source as string) || "";
    const filename = r.filename as string;
    return {
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
async function rerankWithLLM(
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

Respond with a JSON array of objects: [{"index": 0, "relevance_score": 0.85}, ...]
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
async function enrichWithParentContent(env: Env, results: SearchResult[]): Promise<SearchResult[]> {
  if (results.length === 0) return results;
  const sql = db(env);

  // Batch-fetch parent info for all results that are chunks (have parent_id)
  const filenames = results.map((r) => r.filename);
  const sources = results.map((r) => r.source);

  const parentRows = await sql`
    SELECT c.filename AS chunk_filename, c.source AS chunk_source,
           p.filename AS parent_filename, p.content AS parent_content
    FROM documents c
    JOIN documents p ON c.parent_id = p.id
    WHERE c.parent_id IS NOT NULL
      AND (c.filename, c.source) IN (
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
  limit: number = 5
): Promise<SearchResult[]> {
  const queryType = detectQueryType(query);

  if (queryType === "keyword") {
    // Keyword-first: skip embedding generation (~200ms saved), no reranking needed
    const kwResults = await keywordSearch(env, query, source, sourceType, limit);
    if (kwResults.length > 0) return enrichWithParentContent(env, kwResults);
    // Fallback to vector if keyword found nothing
  }

  // Vector path: fetch extra candidates for LLM reranking
  const fetchLimit = Math.max(limit, RERANK_CANDIDATES);
  const vectorResults = await vectorSearch(env, query, source, sourceType, fetchLimit);

  // Low-confidence fallback: if vector top score < threshold, try keyword
  if (vectorResults.length > 0 && vectorResults[0].score < VECTOR_CONFIDENCE_THRESHOLD) {
    const kwFallback = await keywordSearch(env, query, source, sourceType, limit);
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
  source?: string
): Promise<{ filename: string; content: string; source: string; source_type: string; github_url: string | null } | null> {
  const sql = db(env);
  const src = source ?? null;

  const rows = await sql`
    SELECT filename, content, source, source_type
    FROM documents
    WHERE filename = ${filename}
      AND (${src}::text IS NULL OR source = ${src})
    LIMIT 1
  `;

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
  sourceType?: string
): Promise<{ source: string; source_type: string; doc_count: number }[]> {
  const sql = db(env);
  const stype = sourceType ?? null;

  const rows = await sql`
    SELECT source, source_type, COUNT(*)::int AS doc_count
    FROM documents
    WHERE (${stype}::text IS NULL OR source_type = ${stype})
    GROUP BY source, source_type
    ORDER BY source_type, source
  `;

  return rows.map((r) => ({
    source: (r.source as string) || "",
    source_type: (r.source_type as string) || "",
    doc_count: r.doc_count as number,
  }));
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
];

// --- MCP handler ---

async function handleMcpRequest(request: McpRequest, env: Env): Promise<McpResponse> {
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
            serverInfo: { name: "knowledge-mcp", version: "4.0.0" },
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
            (args.limit as number) || 5
          );
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] },
          };
        }

        if (toolName === "get_document") {
          const doc = await getDocument(env, args.filename as string, args.source as string | undefined);
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
          const sources = await listSources(env, args.source_type as string | undefined);
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(sources, null, 2) }] },
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

// --- HTTP server ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/mcp" && request.method === "POST") {
      const body = (await request.json()) as McpRequest;
      const response = await handleMcpRequest(body, env);
      return new Response(JSON.stringify(response), {
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
          version: "4.0.0",
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
