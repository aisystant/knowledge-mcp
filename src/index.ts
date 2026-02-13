/**
 * Knowledge MCP Server v3.0 — Cloudflare Workers AI + Neon (pgvector)
 *
 * Unified MCP server for Pack, guides, and DS knowledge.
 * Embeddings: Cloudflare Workers AI (@cf/baai/bge-m3, 1024d, multilingual)
 * Storage: Neon PostgreSQL with pgvector extension
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

// --- Helpers ---

async function getEmbedding(ai: Ai, text: string): Promise<number[]> {
  const result = await ai.run(EMBEDDING_MODEL, { text: [text] });
  return (result as { data: number[][] }).data[0];
}

function db(env: Env) {
  return neon(env.DATABASE_URL);
}

// --- Tool implementations ---

async function searchDocuments(
  env: Env,
  query: string,
  source?: string,
  sourceType?: string,
  limit: number = 5
): Promise<{ filename: string; content: string; source: string; source_type: string; score: number }[]> {
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
      "Semantic search across knowledge base documents. Searches Pack entities, guides, and DS knowledge.",
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
            serverInfo: { name: "knowledge-mcp", version: "3.0.0" },
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
          version: "3.0.0",
          description: "Unified MCP — Cloudflare Workers AI + Neon pgvector",
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
