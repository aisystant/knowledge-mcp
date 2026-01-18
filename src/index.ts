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

async function surrealQuery<T>(
  host: string,
  namespace: string,
  database: string,
  user: string,
  password: string,
  query: string,
  vars?: Record<string, unknown>
): Promise<T[]> {
  const url = `${host}/sql`;
  const body = vars ? { query, vars } : query;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": vars ? "application/json" : "text/plain",
      Accept: "application/json",
      NS: namespace,
      DB: database,
      Authorization: `Basic ${btoa(`${user}:${password}`)}`,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SurrealDB error: ${response.status} ${text}`);
  }

  const results = (await response.json()) as SurrealResponse<T[]>[];
  if (!results.length || !results[0].result) return [];
  return results[0].result;
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

async function searchDocuments(
  env: Env,
  namespace: string,
  user: string,
  password: string,
  query: string,
  limit: number = 5
): Promise<{ filename: string; content: string; score: number }[]> {
  const queryEmbedding = await getEmbedding(env.OPENAI_API_KEY, query);

  const results = await surrealQuery<Document & { score: number }>(
    env.SURREAL_HOST,
    namespace,
    DEFAULT_DB,
    user,
    password,
    `SELECT filename, content, vector::similarity::cosine(embedding, $embedding) AS score
     FROM ${TABLE_NAME}
     ORDER BY score DESC
     LIMIT $limit`,
    { embedding: queryEmbedding, limit }
  );

  return results.map((r) => ({
    filename: r.filename,
    content: r.content,
    score: r.score,
  }));
}

async function getDocument(
  env: Env,
  namespace: string,
  user: string,
  password: string,
  filename: string
): Promise<{ filename: string; content: string } | null> {
  const results = await surrealQuery<Document>(
    env.SURREAL_HOST,
    namespace,
    DEFAULT_DB,
    user,
    password,
    `SELECT filename, content FROM ${TABLE_NAME} WHERE filename = $filename`,
    { filename }
  );

  if (!results.length) return null;
  return { filename: results[0].filename, content: results[0].content };
}

const TOOLS = [
  {
    name: "search",
    description: "Semantic search across knowledge base documents",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query text",
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
      },
      required: ["filename"],
    },
  },
];

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
            serverInfo: { name: "knowledge-mcp", version: "1.0.0" },
          },
        };

      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

      case "tools/call": {
        const toolName = (params as { name: string }).name;
        const args = (params as { arguments: Record<string, unknown> }).arguments;

        if (toolName === "search") {
          const query = args.query as string;
          const limit = (args.limit as number) || 5;
          const results = await searchDocuments(env, namespace, user, password, query, limit);
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
          const doc = await getDocument(env, namespace, user, password, filename);
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS headers
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

    // SSE endpoint for MCP
    if (url.pathname === "/sse" && request.method === "GET") {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      // Send initial connection message
      const sessionId = crypto.randomUUID();
      writer.write(encoder.encode(`data: ${JSON.stringify({ type: "session", sessionId })}\n\n`));

      return new Response(readable, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // Health check
    if (url.pathname === "/health") {
      return new Response("OK", { headers: corsHeaders });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};
