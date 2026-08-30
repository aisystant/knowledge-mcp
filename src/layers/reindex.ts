// Personal-corpus reindex pipeline for the private MCP mode (WP-410 срез-2b Деплой-2 группа Б).
// Faithful port from personal-knowledge-mcp/src/index.ts (queue producer/consumer + watchdog +
// their file-processing core): listMdFilesViaTrees, startReindexJob, getReindexJobStatus,
// handleQueue, handleWatchdog, chunkContent, readFromGitHub, contentHash, reindexFiles (renamed
// personalReindexFiles — private-only, same disambiguation as personalSearchDocuments/
// personalGetDocument/personalListSources in ./personal.ts, which already own the search-side
// half of this dual-mode split).
//
// Деплой-2 группа В (peer-session 2026-07-03-11): handleWatchdog is wired to scheduled() in
// ../index.ts (private mode) + [triggers] in wrangler.private.toml is live (*/15). startReindexJob
// is called from ../index.ts's connect_source handler (not from connectSource() in ./personal.ts —
// that would be a circular import, since this file already imports from personal.ts). See
// ADR-mcp-unification-q1, inbox/WP-410/WP-410.md, sessions/2026-07/2026-07-01-34-wp410-slice2b-deploy2-groupb.

import { getKnowledgeSchema, KNOWLEDGE_TABLES } from "../utils/db.js";
import {
  resolveUserContext,
  personalDb,
  personalGetEmbedding,
  getInstallationToken,
  documentChunkPrefix,
  assertIndexablePath,
  buildDeleteDocumentQuery,
  type PersonalEnv,
  type UserContext,
} from "./personal.js";
import {
  githubBranchApiUrl,
  githubContentsApiUrl,
  normalizeRepositoryPath,
  resolveSourcePath,
} from "../repository-path.js";

export interface ReindexEnv extends PersonalEnv {
  /** Cloudflare Queue binding for the "reindex" queue. Required to enqueue/consume batches. */
  REINDEX_QUEUE?: Queue<ReindexBatchMessage>;
}

export interface ReindexBatchMessage {
  job_id: string; // UUID from reindex_jobs table
  user_id: string; // Ory identity owning the source
  source: string; // source name, e.g. "DS-my-strategy"
  files: { path: string; action: "modified" | "removed" }[];
}

interface ReindexRequest {
  source: string;
  files: { path: string; action: "added" | "modified" | "removed" }[];
  user_id?: string;
}

const MAX_FILE_SIZE = 100_000; // 100KB — skip large files
const CHUNK_SIZE = 8_000; // ~8K chars per chunk (fits embedding context)
const REINDEX_BATCH_SIZE = 10; // files per queue message, each consumer invocation ≤30s
const REINDEX_COOLDOWN_SECONDS = 60;

// --- File content processing (faithful port of personal-knowledge-mcp/src/index.ts:2246-2332) ---

/**
 * Split content into chunks, preserving every source byte:
 * chunks.join("") === content always holds (WP-7 Ф94 — faithful port of
 * personal-knowledge-mcp/src/index.ts:chunkContent).
 */
export function chunkContent(content: string): string[] {
  if (content.length <= CHUNK_SIZE) return [content];

  const chunks: string[] = [];
  // Zero-width split — sections already cover content exactly. A "## " at
  // content's very start produces a leading "" element (JS split behavior);
  // drop it — it's empty, so this can't affect byte-fidelity, but keeping it
  // would waste an embedding call and shift every ordinal by one.
  const sections = content.split(/(?=^## )/m).filter(s => s.length > 0);

  for (const section of sections) {
    if (section.length <= CHUNK_SIZE) {
      chunks.push(section);
      continue;
    }
    const parts = section.split(/(?=\n\n+)/);
    let current = "";
    for (const part of parts) {
      if (current && current.length + part.length > CHUNK_SIZE) {
        chunks.push(...hardSplit(current));
        current = part;
      } else {
        current += part;
      }
    }
    if (current) chunks.push(...hardSplit(current));
  }

  return chunks;
}

/** Force-split a single piece under CHUNK_SIZE — covers a lone paragraph longer than CHUNK_SIZE. */
function hardSplit(piece: string): string[] {
  if (piece.length <= CHUNK_SIZE) return [piece];
  const out: string[] = [];
  for (let i = 0; i < piece.length; i += CHUNK_SIZE) out.push(piece.slice(i, i + CHUNK_SIZE));
  return out;
}

/** Run async tasks with bounded concurrency — avoids an embedding-API burst per document. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Read file content from GitHub via App Installation Token (GET, distinct from writeToGitHub's PUT). */
async function readFromGitHub(
  env: ReindexEnv,
  ctx: UserContext,
  source: string,
  path: string
): Promise<string | null> {
  const userSource = ctx.sources.find((s) => s.source === source);
  if (!userSource) return null;

  const owner = userSource.githubOwner;
  const repo = userSource.githubRepo;

  // Resolve both configured prefix and request path before auth or network I/O. A malformed
  // source configuration must never reach the installation-token or Contents endpoints.
  const fullPath = resolveSourcePath(userSource.pathPrefix, path).fullPath;

  const token = await getInstallationToken(env, owner);
  if (!token) return null;

  const resp = await fetch(githubContentsApiUrl(owner, repo, fullPath), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.raw+json",
      "User-Agent": "aisystant-knowledge",
    },
  });

  if (!resp.ok) return null;
  return await resp.text();
}

/** Content hash for dedup — truncated to 16 chars, matches documents.hash VARCHAR(16). */
export async function contentHash(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/**
 * Reindex specific files: read from GitHub, chunk, embed, upsert/delete in the personal Neon DB.
 * Private-only — renamed from the source's `reindexFiles` to avoid colliding with the public
 * knowledge-mcp `reindexFiles` in ../index.ts (different DB, different signature, untouched by
 * this file — same disambiguation as personalSearchDocuments/personalGetDocument).
 */
// WP-7 Ф98: error_details mirrors errors[] one-to-one in a structured form the
// webhook can aggregate per file; legacy errors[] is kept verbatim for existing
// consumers. path "*" marks a source-level failure that is not tied to one file.
export interface ReindexErrorDetail { path: string; action: string; reason: string }

export async function personalReindexFiles(
  env: ReindexEnv,
  req: ReindexRequest
): Promise<{ processed: number; deleted: number; skipped: number; errors: string[]; error_details: ReindexErrorDetail[] }> {
  const sql = personalDb(env);
  const schema = getKnowledgeSchema(env);
  const documentsTable = KNOWLEDGE_TABLES.documents(schema);
  const result = { processed: 0, deleted: 0, skipped: 0, errors: [] as string[], error_details: [] as ReindexErrorDetail[] };

  if (!req.user_id) {
    result.errors.push("Missing user_id: personal reindex requires authenticated user context");
    result.error_details.push({ path: "*", action: "n/a", reason: "missing user_id: authenticated user context required" });
    return result;
  }

  const ctx = await resolveUserContext(env, req.user_id);

  if (!ctx.userId) {
    result.errors.push(`Invalid user context for user_id=${req.user_id}`);
    result.error_details.push({ path: "*", action: "n/a", reason: `invalid user context for user_id=${req.user_id}` });
    return result;
  }

  if (!ctx.sourceNames.includes(req.source)) {
    result.errors.push(`Unknown source: ${req.source}. User sources: ${ctx.sourceNames.join(", ")}`);
    result.error_details.push({ path: "*", action: "n/a", reason: `unknown source: ${req.source}` });
    return result;
  }

  for (const file of req.files) {
    let normalizedPath: string;
    try {
      normalizedPath = normalizeRepositoryPath(file.path);
    } catch (err) {
      result.errors.push(`${file.path}: ${err instanceof Error ? err.message : "invalid path"}`);
      result.error_details.push({ path: file.path, action: file.action, reason: err instanceof Error ? err.message : "invalid path" });
      continue;
    }

    if (!normalizedPath.endsWith(".md")) {
      result.skipped++;
      continue;
    }

    try {
      if (file.action === "removed") {
        await buildDeleteDocumentQuery(sql, documentsTable, req.source, ctx.userId, normalizedPath);
        result.deleted++;
        continue;
      }

      assertIndexablePath(normalizedPath);

      const content = await readFromGitHub(env, ctx, req.source, normalizedPath);
      if (!content) {
        result.errors.push(`Cannot read ${normalizedPath} from GitHub`);
        result.error_details.push({ path: normalizedPath, action: file.action, reason: "cannot read from GitHub" });
        continue;
      }

      if (content.length > MAX_FILE_SIZE) {
        result.skipped++;
        continue;
      }

      // Check hash — skip only if unchanged AND already on v2. A hash match on
      // a still-legacy row must NOT skip — it would never get backfilled to v2
      // otherwise, since a reindex re-run is the only backfill path and most
      // content doesn't change between runs (WP-7 Ф94).
      const hash = await contentHash(content);
      const chunkPrefix = documentChunkPrefix(normalizedPath);
      const existing = await sql`
        SELECT hash, protocol_version FROM ${sql.unsafe(documentsTable)}
        WHERE (filename = ${normalizedPath} OR left(filename, char_length(${chunkPrefix})) = ${chunkPrefix})
          AND source = ${req.source} AND user_id = ${ctx.userId}
        LIMIT 1
      `;
      if (existing.length > 0 && existing[0].hash === hash && existing[0].protocol_version === 2) {
        result.skipped++;
        continue;
      }

      const chunks = chunkContent(content);
      const sourceType = ctx.sources.find((s) => s.source === req.source)?.sourceType || "ds";
      const embeddings = await mapWithConcurrency(chunks, 4, c => personalGetEmbedding(env.OPENROUTER_API_KEY ?? "", c.slice(0, 8000)));

      // Delete old chunks (both protocol versions) and insert the new v2 set as
      // one transaction — a mid-write crash can never leave a partial document
      // visible to readers (WP-7 Ф94).
      await sql.transaction([
        buildDeleteDocumentQuery(sql, documentsTable, req.source, ctx.userId, normalizedPath),
        ...chunks.map((c, i) => sql`
          INSERT INTO ${sql.unsafe(documentsTable)}
            (filename, content, source, source_type, hash, embedding, search_vector, user_id, chunk_ordinal, protocol_version)
          VALUES (
            ${normalizedPath}, ${c}, ${req.source}, ${sourceType}, ${hash},
            ${`[${embeddings[i].join(",")}]`}::vector, to_tsvector('simple', ${c}), ${ctx.userId}, ${i + 1}, 2
          )
        `),
      ]);

      result.processed++;
    } catch (err) {
      result.errors.push(`${file.path}: ${err instanceof Error ? err.message : "unknown error"}`);
      result.error_details.push({ path: file.path, action: file.action, reason: err instanceof Error ? err.message : "unknown error" });
    }
  }

  return result;
}

// --- GitHub Trees listing (faithful port of personal-knowledge-mcp/src/index.ts:2429-2493) ---

interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
  url?: string;
}

/** Restrict a recursive Git tree to the configured directory segment, then relativize it. */
export function relativeMarkdownPathsFromTree(
  tree: GitHubTreeEntry[],
  pathPrefix: string,
): string[] {
  const normalizedPrefix = pathPrefix ? normalizeRepositoryPath(pathPrefix) : "";
  const prefixBoundary = normalizedPrefix ? `${normalizedPrefix}/` : "";

  return tree
    .filter(entry => entry.type === "blob" && entry.path.endsWith(".md"))
    .filter(entry => !prefixBoundary || entry.path.startsWith(prefixBoundary))
    .map(entry => prefixBoundary ? entry.path.slice(prefixBoundary.length) : entry.path)
    .filter(path => path.length > 0);
}

/**
 * List all .md files in a source repo via GitHub Trees API (recursive, single call).
 * Returns paths relative to pathPrefix (same shape as webhook ReindexFile).
 */
async function listMdFilesViaTrees(env: ReindexEnv, ctx: UserContext, source: string): Promise<string[]> {
  const userSource = ctx.sources.find((s) => s.source === source);
  if (!userSource) return [];

  // Validate the configured source boundary before token acquisition or GitHub metadata calls.
  // Keep the canonical prefix for the later tree-boundary filter.
  let normalizedPrefix: string;
  try {
    normalizedPrefix = userSource.pathPrefix
      ? normalizeRepositoryPath(userSource.pathPrefix)
      : "";
  } catch {
    return [];
  }

  const token = await getInstallationToken(env, userSource.githubOwner);
  if (!token) return [];

  const repoResp = await fetch(`https://api.github.com/repos/${userSource.githubOwner}/${userSource.githubRepo}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "aisystant-knowledge" },
  });
  if (!repoResp.ok) return [];
  const repoJson = (await repoResp.json()) as { default_branch?: string };
  const branch = repoJson.default_branch;
  if (!branch) return [];

  const branchResp = await fetch(githubBranchApiUrl(userSource.githubOwner, userSource.githubRepo, branch), {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "aisystant-knowledge" },
  });
  if (!branchResp.ok) return [];
  const branchJson = (await branchResp.json()) as { commit?: { sha?: string } };
  const commitSha = branchJson.commit?.sha;
  if (!commitSha) return [];

  const treeResp = await fetch(`https://api.github.com/repos/${userSource.githubOwner}/${userSource.githubRepo}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "aisystant-knowledge" },
  });
  if (!treeResp.ok) return [];
  const treeJson = (await treeResp.json()) as { tree?: GitHubTreeEntry[]; truncated?: boolean };
  if (!treeJson.tree) return [];

  if (treeJson.truncated) {
    console.warn(`listMdFilesViaTrees: tree truncated for ${source} (>100k entries)`);
  }
  return relativeMarkdownPathsFromTree(treeJson.tree, normalizedPrefix);
}

// --- Reindex jobs: producer + status (faithful port of index.ts:2495-2660) ---

export interface ReindexSourceResult {
  job_id: string;
  status: "running" | "cooldown" | "failed";
  message: string;
  source: string;
}

/**
 * Start an async reindex job: list files via GitHub Trees, split into batches of
 * REINDEX_BATCH_SIZE, enqueue via env.REINDEX_QUEUE.sendBatch, return job_id immediately.
 * handleQueue (below) processes each batch ≤30s.
 *
 * Cooldown: refuse new job if a job for the same (user, source) started within last 60s.
 *
 * No caller yet in this codebase — connectSource (../layers/personal.ts) still hardcodes
 * reindex_triggered:false; wiring the trigger is Деплой-2 группа В.
 */
export async function startReindexJob(env: ReindexEnv, userId: string, source: string): Promise<ReindexSourceResult> {
  const sql = personalDb(env);
  const schema = getKnowledgeSchema(env);
  const reindexJobsTable = KNOWLEDGE_TABLES.reindex_jobs(schema);

  const recent = await sql`
    SELECT id, status, started_at FROM ${sql.unsafe(reindexJobsTable)}
    WHERE user_id = ${userId} AND source = ${source}
      AND started_at > NOW() - (${REINDEX_COOLDOWN_SECONDS} * INTERVAL '1 second')
    ORDER BY started_at DESC LIMIT 1
  `;
  if (recent.length > 0) {
    const row = recent[0];
    return {
      job_id: row.id as string,
      status: "cooldown",
      message: row.status === "running"
        ? `Reindex already running for ${source} (job ${row.id}). Poll with reindex_status.`
        : `Reindex for ${source} was started within last ${REINDEX_COOLDOWN_SECONDS}s (job ${row.id}). Retry later.`,
      source,
    };
  }

  if (!env.REINDEX_QUEUE) {
    return { job_id: "", status: "failed", message: "REINDEX_QUEUE binding missing — reindex is unavailable in this deployment", source };
  }

  const rows = await sql`
    INSERT INTO ${sql.unsafe(reindexJobsTable)} (user_id, source, status)
    VALUES (${userId}, ${source}, 'pending')
    RETURNING id
  `;
  const jobId = rows[0].id as string;

  try {
    const ctx = await resolveUserContext(env, userId);
    if (!ctx.sourceNames.includes(source)) {
      await sql`UPDATE ${sql.unsafe(reindexJobsTable)}
        SET status = 'failed', finished_at = NOW(),
            errors = ${JSON.stringify([`Unknown source: ${source}`])}::jsonb
        WHERE id = ${jobId}::uuid`;
      return { job_id: jobId, status: "failed", message: `Unknown source: ${source}`, source };
    }

    const paths = await listMdFilesViaTrees(env, ctx, source);

    const batches: ReindexBatchMessage[] = [];
    for (let i = 0; i < paths.length; i += REINDEX_BATCH_SIZE) {
      batches.push({
        job_id: jobId,
        user_id: userId,
        source,
        files: paths.slice(i, i + REINDEX_BATCH_SIZE).map((p) => ({ path: p, action: "modified" as const })),
      });
    }

    await sql`UPDATE ${sql.unsafe(reindexJobsTable)}
      SET status = 'running', total = ${paths.length}, expected_batches = ${batches.length},
          last_heartbeat_at = NOW()
      WHERE id = ${jobId}::uuid`;

    if (batches.length === 0) {
      await sql`UPDATE ${sql.unsafe(reindexJobsTable)}
        SET status = 'succeeded', finished_at = NOW()
        WHERE id = ${jobId}::uuid`;
      return { job_id: jobId, status: "running", message: `No files to reindex for ${source}.`, source };
    }

    // CF Queues sendBatch limit is ~256KB total payload — send in chunks of 20 to stay within it.
    const SEND_CHUNK_SIZE = 20;
    for (let i = 0; i < batches.length; i += SEND_CHUNK_SIZE) {
      const chunk = batches.slice(i, i + SEND_CHUNK_SIZE);
      await env.REINDEX_QUEUE.sendBatch(chunk.map((b) => ({ body: b })));
    }

    console.log(JSON.stringify({ phase: "enqueue", job_id: jobId, source, total_files: paths.length, batches: batches.length }));

    return {
      job_id: jobId,
      status: "running",
      message: `Reindex started for ${source}: ${paths.length} file(s) in ${batches.length} batch(es). Poll reindex_status with job_id.`,
      source,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    await sql`UPDATE ${sql.unsafe(reindexJobsTable)}
      SET status = 'failed', finished_at = NOW(),
          errors = ${JSON.stringify([msg])}::jsonb
      WHERE id = ${jobId}::uuid`;
    return { job_id: jobId, status: "failed", message: `Failed to start reindex: ${msg}`, source };
  }
}

export interface ReindexStatusResult {
  job_id: string;
  source: string;
  status: string;
  processed: number;
  skipped: number;
  deleted: number;
  total: number | null;
  errors: string[];
  started_at: string;
  finished_at: string | null;
}

export async function getReindexJobStatus(env: ReindexEnv, userId: string, jobId: string): Promise<ReindexStatusResult | null> {
  const sql = personalDb(env);
  const schema = getKnowledgeSchema(env);
  const reindexJobsTable = KNOWLEDGE_TABLES.reindex_jobs(schema);
  const rows = await sql`
    SELECT id, source, status, processed, skipped, deleted, total, errors, started_at, finished_at
    FROM ${sql.unsafe(reindexJobsTable)}
    WHERE id = ${jobId}::uuid AND user_id = ${userId}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    job_id: r.id as string,
    source: r.source as string,
    status: r.status as string,
    processed: r.processed as number,
    skipped: r.skipped as number,
    deleted: r.deleted as number,
    total: (r.total as number | null) ?? null,
    errors: (r.errors as string[]) || [],
    started_at: (r.started_at as Date).toISOString(),
    finished_at: r.finished_at ? (r.finished_at as Date).toISOString() : null,
  };
}

// --- Queue consumer (faithful port of index.ts:2917-3019) ---

/**
 * Consumer for queue "reindex". Each message = one batch of up to REINDEX_BATCH_SIZE files.
 * Must finish per-message work within Cloudflare's 30s wall-clock limit (plus retries).
 *
 * Idempotency: personalReindexFiles() reads document hash before writing — re-delivery of the
 * same batch produces zero embeddings and zero INSERTs (skipped++). Ack/retry is per-message
 * (msg.ack() / msg.retry()), so a poison file cannot block the whole job.
 *
 * Completion: completed_batches = expected_batches → status='succeeded'. handleWatchdog (below)
 * marks stale 'running' jobs failed after NOW() - last_heartbeat_at > 60min — not wired to a
 * cron trigger yet (Деплой-2 группа В).
 */
export async function handleQueue(batch: MessageBatch<ReindexBatchMessage>, env: ReindexEnv): Promise<void> {
  const sql = personalDb(env);
  const schema = getKnowledgeSchema(env);

  for (const msg of batch.messages) {
    const { job_id, user_id, source, files } = msg.body;
    const startedAt = Date.now();

    try {
      const jobRows = await sql`
        SELECT status FROM ${sql.unsafe(KNOWLEDGE_TABLES.reindex_jobs(schema))} WHERE id = ${job_id}::uuid LIMIT 1
      `;
      if (jobRows.length === 0) {
        console.warn(JSON.stringify({ phase: "consume_skip", reason: "job_not_found", job_id }));
        msg.ack();
        continue;
      }
      const jobStatus = jobRows[0].status as string;
      if (jobStatus !== "running") {
        console.warn(JSON.stringify({ phase: "consume_skip", reason: "job_not_running", job_id, status: jobStatus }));
        msg.ack();
        continue;
      }

      const result = await personalReindexFiles(env, { source, files, user_id });

      const errorsJson = JSON.stringify(result.errors);
      const updated = await sql`
        UPDATE ${sql.unsafe(KNOWLEDGE_TABLES.reindex_jobs(schema))}
          SET processed = processed + ${result.processed},
              skipped = skipped + ${result.skipped},
              deleted = deleted + ${result.deleted},
              completed_batches = completed_batches + 1,
              last_heartbeat_at = NOW(),
              errors = COALESCE(errors, '[]'::jsonb) || ${errorsJson}::jsonb
          WHERE id = ${job_id}::uuid
          RETURNING completed_batches, expected_batches
      `;

      if (updated.length > 0) {
        const { completed_batches, expected_batches } = updated[0] as { completed_batches: number; expected_batches: number | null };
        if (expected_batches !== null && completed_batches >= expected_batches) {
          await sql`
            UPDATE ${sql.unsafe(KNOWLEDGE_TABLES.reindex_jobs(schema))}
              SET status = 'succeeded', finished_at = NOW()
              WHERE id = ${job_id}::uuid AND status = 'running'
          `;
        }
      }

      console.log(JSON.stringify({
        phase: "consume_ok",
        job_id, source,
        files: files.length,
        processed: result.processed,
        skipped: result.skipped,
        deleted: result.deleted,
        errors: result.errors.length,
        elapsed_ms: Date.now() - startedAt,
        attempt: msg.attempts,
      }));

      msg.ack();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "unknown error";
      console.error(JSON.stringify({
        phase: "consume_err",
        job_id, source,
        files: files.length,
        error: errMsg,
        elapsed_ms: Date.now() - startedAt,
        attempt: msg.attempts,
      }));
      // Let Queues retry (max_retries from wrangler.private.toml). After that → DLQ (reindex-dlq).
      msg.retry();
    }
  }
}

// --- Watchdog (faithful port of index.ts:3332-3389, threshold retuned for Деплой-2 группа В) ---

// Cron fires every 15 min (wrangler.private.toml [triggers]) — a 60-min stale threshold (carried
// over from the old once-an-hour monolith cron) would let a stuck job sit unfixed for up to ~74
// min. Two watchdog cycles + margin = 30 min. Override via WATCHDOG_STALE_MINUTES for tuning
// without a redeploy of the threshold logic itself.
const DEFAULT_WATCHDOG_STALE_MINUTES = 30;

/**
 * Mark stale 'running' jobs failed (last_heartbeat_at older than WATCHDOG_STALE_MINUTES).
 * Causes of getting stuck: whole batch landed in DLQ, worker died between ack and UPDATE,
 * expected_batches never matched. Without the watchdog such jobs stay 'running' forever.
 *
 * Wired to scheduled() in ../index.ts (private mode) via wrangler.private.toml [triggers]
 * (Деплой-2 группа В).
 */
export async function handleWatchdog(env: ReindexEnv): Promise<void> {
  if (!env.DATABASE_URL) {
    console.warn(JSON.stringify({ phase: "watchdog_skip", reason: "no_database_url" }));
    return;
  }
  const sql = personalDb(env);
  const schema = getKnowledgeSchema(env);
  const staleMinutes = Number(env.WATCHDOG_STALE_MINUTES) || DEFAULT_WATCHDOG_STALE_MINUTES;
  const started = Date.now();
  try {
    const stale = await sql`
      UPDATE ${sql.unsafe(KNOWLEDGE_TABLES.reindex_jobs(schema))}
      SET status = 'failed',
          finished_at = NOW(),
          errors = COALESCE(errors, '[]'::jsonb) || '[{"reason":"watchdog_stale_heartbeat"}]'::jsonb
      WHERE status = 'running'
        AND last_heartbeat_at IS NOT NULL
        AND NOW() - last_heartbeat_at > (${staleMinutes} * INTERVAL '1 minute')
      RETURNING id, user_id, source, completed_batches, expected_batches
    `;
    console.log(JSON.stringify({
      phase: "watchdog_ok",
      stale_count: stale.length,
      stale_jobs: stale.map((r) => ({ id: r.id, user_id_prefix: (r.user_id as string).slice(0, 8), source: r.source, completed: r.completed_batches, expected: r.expected_batches })),
      elapsed_ms: Date.now() - started,
    }));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown error";
    console.error(JSON.stringify({ phase: "watchdog_err", error: errMsg, elapsed_ms: Date.now() - started }));
  }
}
