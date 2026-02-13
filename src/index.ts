interface Env {
  SURREAL_HOST: string;
  SURREAL_USER: string;
  SURREAL_PASSWORD: string;
  OPENAI_API_KEY: string;
}

const EMBEDDING_MODEL = "text-embedding-3-large";
const TABLE_NAME = "documents";
const DEFAULT_DB = "knowledge";

interface Document {
  id: string;
  filename: string;
  content: string;
  embedding: number[];
  hash: string;
  source: string;
  source_type: string;
}

interface SurrealResponse<T> {
  result: T;
  status: string;
  time: string;
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

async function surrealSignin(
  host: string,
  namespace: string,
  username: string,
  password: string
): Promise<string> {
  const response = await fetch(`${host}/signin`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ ns: namespace, user: username, pass: password }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SurrealDB signin error: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { token: string };
  return data.token;
}

async function surrealQuery<T>(
  host: string,
  namespace: string,
  database: string,
  user: string,
  password: string,
  query: string
): Promise<T[]> {
  const token = await surrealSignin(host, namespace, user, password);

  const response = await fetch(`${host}/sql`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      Accept: "application/json",
      "surreal-ns": namespace,
      "surreal-db": database,
      Authorization: `Bearer ${token}`,
    },
    body: query,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SurrealDB error: ${response.status} ${text}`);
  }

  const json = await response.json();
  const results = json as SurrealResponse<T[]>[];
  if (!results.length || !results[0].result) return [];
  const result = results[0].result;
  return Array.isArray(result) ? result : [result] as T[];
}

async function getEmbedding(apiKey: string, text: string): Promise<number[]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: text,
      model: EMBEDDING_MODEL,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI error: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { data: [{ embedding: number[] }] };
  return data.data[0].embedding;
}

// --- Tool implementations ---

async function searchDocuments(
  env: Env,
  namespace: string,
  user: string,
  password: string,
  query: string,
  source?: string,
  sourceType?: string,
  limit: number = 5
): Promise<{ filename: string; content: string; source: string; source_type: string; score: number }[]> {
  const queryEmbedding = await getEmbedding(env.OPENAI_API_KEY, query);
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  const conditions: string[] = [];
  if (source) {
    const escaped = source.replace(/'/g, "\\'");
    conditions.push(`source = '${escaped}'`);
  }
  if (sourceType) {
    const escaped = sourceType.replace(/'/g, "\\'");
    conditions.push(`source_type = '${escaped}'`);
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const results = await surrealQuery<Document & { score: number }>(
    env.SURREAL_HOST,
    namespace,
    DEFAULT_DB,
    user,
    password,
    `SELECT filename, content, source, source_type, vector::similarity::cosine(embedding, ${embeddingStr}) AS score FROM ${TABLE_NAME} ${whereClause} ORDER BY score DESC LIMIT ${limit}`
  );

  return results.map((r) => ({
    filename: r.filename,
    content: r.content,
    source: r.source || "",
    source_type: r.source_type || "",
    score: r.score,
  }));
}

async function getDocument(
  env: Env,
  namespace: string,
  user: string,
  password: string,
  filename: string,
  source?: string
): Promise<{ filename: string; content: string; source: string; source_type: string } | null> {
  const escaped = filename.replace(/'/g, "\\'");
  let query = `SELECT filename, content, source, source_type FROM ${TABLE_NAME} WHERE filename = '${escaped}'`;

  if (source) {
    const escapedSource = source.replace(/'/g, "\\'");
    query += ` AND source = '${escapedSource}'`;
  }

  const results = await surrealQuery<Document>(
    env.SURREAL_HOST,
    namespace,
    DEFAULT_DB,
    user,
    password,
    query
  );

  if (!results.length) return null;
  return {
    filename: results[0].filename,
    content: results[0].content,
    source: results[0].source || "",
    source_type: results[0].source_type || "",
  };
}

async function listSources(
  env: Env,
  namespace: string,
  user: string,
  password: string,
  sourceType?: string
): Promise<{ source: string; source_type: string; doc_count: number }[]> {
  let query = `SELECT source, source_type, count() AS doc_count FROM ${TABLE_NAME}`;

  if (sourceType) {
    const escaped = sourceType.replace(/'/g, "\\'");
    query += ` WHERE source_type = '${escaped}'`;
  }

  query += ` GROUP BY source, source_type ORDER BY source_type, source`;

  return await surrealQuery<{ source: string; source_type: string; doc_count: number }>(
    env.SURREAL_HOST,
    namespace,
    DEFAULT_DB,
    user,
    password,
    query
  );
}

// --- MCP tool definitions ---

const TOOLS = [
  {
    name: "search",
    description: "Semantic search across knowledge base documents. Searches Pack entities, guides, and DS knowledge. Use source_type to filter by category.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query text",
        },
        source: {
          type: "string",
          description: "Filter by specific source (e.g., 'PACK-digital-platform', 'PACK-personal')",
        },
        source_type: {
          type: "string",
          enum: ["pack", "guides", "ds"],
          description: "Filter by source type: pack (domain knowledge), guides (educational content), ds (ecosystem processes)",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 5)",
        },
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
        filename: {
          type: "string",
          description: "Document filename (relative path)",
        },
        source: {
          type: "string",
          description: "Source name to disambiguate if filename exists in multiple sources",
        },
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

// --- MCP request handler ---

async function handleMcpRequest(
  request: McpRequest,
  env: Env
): Promise<McpResponse> {
  const { id, method, params } = request;
  const { SURREAL_USER: user, SURREAL_PASSWORD: password } = env;
  const namespace = user;

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "knowledge-mcp", version: "2.0.0" },
          },
        };

      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

      case "tools/call": {
        const toolName = (params as { name: string }).name;
        const args = (params as { arguments: Record<string, unknown> }).arguments;

        if (toolName === "search") {
          const query = args.query as string;
          const source = args.source as string | undefined;
          const sourceType = args.source_type as string | undefined;
          const limit = (args.limit as number) || 5;
          const results = await searchDocuments(env, namespace, user, password, query, source, sourceType, limit);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
            },
          };
        }

        if (toolName === "get_document") {
          const filename = args.filename as string;
          const source = args.source as string | undefined;
          const doc = await getDocument(env, namespace, user, password, filename, source);
          if (!doc) {
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: "Document not found" }],
                isError: true,
              },
            };
          }
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: doc.content }],
            },
          };
        }

        if (toolName === "list_sources") {
          const sourceType = args?.source_type as string | undefined;
          const sources = await listSources(env, namespace, user, password, sourceType);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(sources, null, 2) }],
            },
          };
        }

        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unknown tool: ${toolName}` },
        };
      }

      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
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

    // MCP endpoint
    if (url.pathname === "/mcp" && request.method === "POST") {
      const body = (await request.json()) as McpRequest;
      const response = await handleMcpRequest(body, env);
      return new Response(JSON.stringify(response), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Health check / info
    if (url.pathname === "/health") {
      return new Response("OK", { headers: corsHeaders });
    }

    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          name: "Knowledge MCP Server",
          version: "2.0.0",
          description: "Unified MCP server for Pack, guides, and DS knowledge",
          mcp_endpoint: "/mcp",
          transport: "HTTP POST (JSON-RPC)",
          tools: TOOLS.map((t) => t.name),
          source_types: ["pack", "guides", "ds"],
        }),
        { headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};
