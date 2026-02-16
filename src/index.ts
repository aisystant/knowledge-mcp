/**
 * Knowledge MCP Server v3.1 — Hybrid Search (vector + keyword)
 *
 * Unified MCP server for Pack, guides, and DS knowledge.
 * Embeddings: Cloudflare Workers AI (@cf/baai/bge-m3, 1024d, multilingual)
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
  AI: Ai;
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

const EMBEDDING_MODEL = "@cf/baai/bge-m3";
const VECTOR_CONFIDENCE_THRESHOLD = 0.6;

// --- Helpers ---

async function getEmbedding(ai: Ai, text: string): Promise<number[]> {
  const result = await ai.run(EMBEDDING_MODEL, { text: [text] });
  return (result as { data: number[][] }).data[0];
}

function db(env: Env) {
  return neon(env.DATABASE_URL);
}

// --- Query type detection (DP.D.024) ---

type QueryType = "keyword" | "vector";

function detectQueryType(query: string): QueryType {
  // Entity codes: DP.AGENT.001, MIM.M.003, SOTA.002, SPF.SPEC.001, etc.
  if (/[A-Z]{2,}\.\w+\.\d+/.test(query)) return "keyword";
  // Short queries with dots — likely structured identifiers
  if (query.length < 30 && /\.[A-Z]/.test(query)) return "keyword";
  // Default: semantic vector search
  return "vector";
}

// --- Tool implementations ---

type SearchResult = { filename: string; content: string; source: string; source_type: string; score: number };

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

  const rows = await sql`
    SELECT filename, content, source, source_type,
           CASE
             WHEN filename ILIKE ${pattern} THEN 1.0
             WHEN content ILIKE ${pattern} THEN 0.95
             WHEN search_vector @@ plainto_tsquery('simple', ${ftsQuery}) THEN 0.8
             ELSE 0.5
           END AS score
    FROM documents
    WHERE (content ILIKE ${pattern}
           OR filename ILIKE ${pattern}
           OR search_vector @@ plainto_tsquery('simple', ${ftsQuery}))
      AND (${src}::text IS NULL OR source = ${src})
      AND (${stype}::text IS NULL OR source_type = ${stype})
    ORDER BY score DESC,
             CASE WHEN filename ILIKE ${pattern} THEN 0 ELSE 1 END,
             length(content) ASC
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    filename: r.filename as string,
    content: r.content as string,
    source: (r.source as string) || "",
    source_type: (r.source_type as string) || "",
    score: r.score as number,
  }));
}

async function vectorSearch(
  env: Env,
  query: string,
  source?: string,
  sourceType?: string,
  limit: number = 5
): Promise<SearchResult[]> {
  const embedding = await getEmbedding(env.AI, query);
  const vec = `[${embedding.join(",")}]`;
  const sql = db(env);
  const src = source ?? null;
  const stype = sourceType ?? null;

  const rows = await sql`
    SELECT filename, content, source, source_type,
           1 - (embedding <=> ${vec}::vector) AS score
    FROM documents
    WHERE (${src}::text IS NULL OR source = ${src})
      AND (${stype}::text IS NULL OR source_type = ${stype})
    ORDER BY embedding <=> ${vec}::vector
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    filename: r.filename as string,
    content: r.content as string,
    source: (r.source as string) || "",
    source_type: (r.source_type as string) || "",
    score: r.score as number,
  }));
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
    // Keyword-first: skip embedding generation (~200ms saved)
    const kwResults = await keywordSearch(env, query, source, sourceType, limit);
    if (kwResults.length > 0) return kwResults;
    // Fallback to vector if keyword found nothing
  }

  const vectorResults = await vectorSearch(env, query, source, sourceType, limit);

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
      return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    }
  }

  return vectorResults;
}

async function getDocument(
  env: Env,
  filename: string,
  source?: string
): Promise<{ filename: string; content: string; source: string; source_type: string } | null> {
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
  return {
    filename: r.filename as string,
    content: r.content as string,
    source: (r.source as string) || "",
    source_type: (r.source_type as string) || "",
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
      "Hybrid search across knowledge base documents. Searches Pack entities, guides, and DS knowledge. Uses keyword search for entity codes (e.g. DP.AGENT.001) and semantic vector search for natural language queries.",
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
          enum: ["pack", "guides", "ds"],
          description: "Filter by source type: pack (domain knowledge), guides (educational), ds (processes)",
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
            serverInfo: { name: "knowledge-mcp", version: "3.1.1" },
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
          version: "3.1.1",
          description: "Hybrid MCP — Cloudflare Workers AI + Neon pgvector + pg_trgm",
          mcp_endpoint: "/mcp",
          tools: TOOLS.map((t) => t.name),
          source_types: ["pack", "guides", "ds"],
        }),
        { headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};
