/**
 * Database schema parameterization utility for knowledge-mcp
 *
 * Replaces hardcoded schema.table references with environment-based qualifiers.
 * Supports three independent schemas: knowledge, concept_graph, health.
 *
 * Usage:
 *   const docsTable = KNOWLEDGE_TABLES.documents(getKnowledgeSchema(env));
 *   const sql = neon(DATABASE_URL);
 *   await sql`SELECT * FROM ${sql(docsTable)}`; // neon() handles escaping
 *
 * WP-268 Phase 3: Enables database migrations without code changes
 */

export interface Env {
  KNOWLEDGE_DB_SCHEMA?: string; // Default: "knowledge"
  CONCEPT_GRAPH_DB_SCHEMA?: string; // Default: "concept_graph"
  HEALTH_DB_SCHEMA?: string; // Default: "health"
}

/**
 * Get knowledge schema name from environment
 * Defaults to "knowledge" if not specified
 */
export function getKnowledgeSchema(env?: Env | Record<string, unknown>): string {
  if (!env) return "knowledge";
  const e = env as any;
  return e.KNOWLEDGE_DB_SCHEMA || "knowledge";
}

/**
 * Get concept_graph schema name from environment
 * Defaults to "concept_graph" if not specified
 */
export function getConceptGraphSchema(env?: Env | Record<string, unknown>): string {
  if (!env) return "concept_graph";
  const e = env as any;
  return e.CONCEPT_GRAPH_DB_SCHEMA || "concept_graph";
}

/**
 * Get health schema name from environment
 * Defaults to "health" if not specified
 */
export function getHealthSchema(env?: Env | Record<string, unknown>): string {
  if (!env) return "health";
  const e = env as any;
  return e.HEALTH_DB_SCHEMA || "health";
}

/**
 * Qualify table name with schema prefix
 * Returns unescaped string — let neon/sql handle escaping via template literals
 *
 * @param table Table name (e.g., "documents", "concepts")
 * @param schema Schema name (required)
 * @returns Qualified name (e.g., "knowledge.documents")
 */
export function qualifyTable(table: string, schema: string): string {
  return `${schema}.${table}`;
}

/**
 * Knowledge schema tables
 * Tables: knowledge_chunk, retrieval_feedback, reindex_jobs, user_sources, github_installations
 */
export const KNOWLEDGE_TABLES = {
  knowledge_chunk: (schema: string) => qualifyTable("knowledge_chunk", schema),
  retrieval_feedback: (schema: string) => qualifyTable("retrieval_feedback", schema),
  reindex_jobs: (schema: string) => qualifyTable("reindex_jobs", schema),
  user_sources: (schema: string) => qualifyTable("user_sources", schema),
  github_installations: (schema: string) => qualifyTable("github_installations", schema),
};

/**
 * Concept graph schema tables
 * Tables: concepts, concept_edges, concept_misconceptions, learner_concept_mastery, last_traversed_at (temporal)
 */
export const CONCEPT_GRAPH_TABLES = {
  concepts: (schema: string) => qualifyTable("concepts", schema),
  concept_edges: (schema: string) => qualifyTable("concept_edges", schema),
  concept_misconceptions: (schema: string) => qualifyTable("concept_misconceptions", schema),
  learner_concept_mastery: (schema: string) => qualifyTable("learner_concept_mastery", schema),
};

/**
 * Health schema tables
 * Tables: graph_usage_events (observability writes)
 */
export const HEALTH_TABLES = {
  graph_usage_events: (schema: string) => qualifyTable("graph_usage_events", schema),
};
