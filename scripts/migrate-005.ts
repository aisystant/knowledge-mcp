#!/usr/bin/env npx tsx
/**
 * Apply migration 005-concept-graph.sql via Neon serverless driver.
 * Uses tagged template literals as required by @neondatabase/serverless.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { neon } from "@neondatabase/serverless";

const __dirname = dirname(fileURLToPath(import.meta.url));

const devVars = readFileSync(join(__dirname, "../.dev.vars"), "utf-8");
const dbUrlMatch = devVars.match(/DATABASE_URL=(.+)/);
if (!dbUrlMatch) throw new Error("DATABASE_URL not found in .dev.vars");

const dbUrl = dbUrlMatch[1].trim().replace("-pooler", "");
const sql = neon(dbUrl);

console.log("Applying migration 005-concept-graph.sql...\n");

// Schema
console.log("1. Creating schema...");
await sql`CREATE SCHEMA IF NOT EXISTS concept_graph`;
console.log("  ✅ concept_graph schema");

// Concepts table
console.log("2. Creating concepts table...");
await sql`
  CREATE TABLE IF NOT EXISTS concept_graph.concepts (
    id BIGSERIAL PRIMARY KEY,
    code TEXT UNIQUE,
    name TEXT NOT NULL,
    definition TEXT,
    level TEXT NOT NULL CHECK (level IN ('zp', 'fpf', 'pack', 'guide', 'course')),
    domain TEXT,
    source_doc TEXT,
    source_repo TEXT,
    document_id BIGINT REFERENCES public.documents(id) ON DELETE SET NULL,
    embedding vector(1024),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'draft')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`;
console.log("  ✅ concept_graph.concepts");

// Concepts indexes
console.log("3. Creating concept indexes...");
await sql`CREATE INDEX IF NOT EXISTS idx_concepts_code ON concept_graph.concepts(code)`;
await sql`CREATE INDEX IF NOT EXISTS idx_concepts_level ON concept_graph.concepts(level)`;
await sql`CREATE INDEX IF NOT EXISTS idx_concepts_domain ON concept_graph.concepts(domain)`;
await sql`CREATE INDEX IF NOT EXISTS idx_concepts_name_trgm ON concept_graph.concepts USING gin(name gin_trgm_ops)`;
await sql`CREATE INDEX IF NOT EXISTS idx_concepts_embedding ON concept_graph.concepts USING hnsw (embedding vector_cosine_ops)`;
console.log("  ✅ 5 indexes");

// Edges table
console.log("4. Creating concept_edges table...");
await sql`
  CREATE TABLE IF NOT EXISTS concept_graph.concept_edges (
    id BIGSERIAL PRIMARY KEY,
    from_concept_id BIGINT NOT NULL REFERENCES concept_graph.concepts(id) ON DELETE CASCADE,
    to_concept_id BIGINT NOT NULL REFERENCES concept_graph.concepts(id) ON DELETE CASCADE,
    edge_type TEXT NOT NULL CHECK (edge_type IN (
      'prerequisite', 'related', 'part_of', 'specializes', 'contradicts'
    )),
    weight REAL NOT NULL DEFAULT 0.5 CHECK (weight >= 0 AND weight <= 1),
    weight_source TEXT NOT NULL DEFAULT 'llm' CHECK (weight_source IN (
      'manual', 'llm', 'pmi', 'embedding', 'computed'
    )),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(from_concept_id, to_concept_id, edge_type)
  )
`;
console.log("  ✅ concept_graph.concept_edges");

// Edge indexes
console.log("5. Creating edge indexes...");
await sql`CREATE INDEX IF NOT EXISTS idx_edges_from ON concept_graph.concept_edges(from_concept_id)`;
await sql`CREATE INDEX IF NOT EXISTS idx_edges_to ON concept_graph.concept_edges(to_concept_id)`;
await sql`CREATE INDEX IF NOT EXISTS idx_edges_type ON concept_graph.concept_edges(edge_type)`;
console.log("  ✅ 3 indexes");

// Misconceptions table
console.log("6. Creating misconceptions table...");
await sql`
  CREATE TABLE IF NOT EXISTS concept_graph.concept_misconceptions (
    id BIGSERIAL PRIMARY KEY,
    concept_id BIGINT NOT NULL REFERENCES concept_graph.concepts(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK (category IN (
      'wrong_concept', 'wrong_application', 'folk_substitution'
    )),
    misconception_text TEXT NOT NULL,
    correct_version TEXT,
    folk_term TEXT,
    source_file TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`;
console.log("  ✅ concept_graph.concept_misconceptions");

await sql`CREATE INDEX IF NOT EXISTS idx_misconceptions_concept ON concept_graph.concept_misconceptions(concept_id)`;
await sql`CREATE INDEX IF NOT EXISTS idx_misconceptions_category ON concept_graph.concept_misconceptions(category)`;
console.log("  ✅ 2 indexes");

// Learner mastery table
console.log("7. Creating learner_concept_mastery table...");
await sql`
  CREATE TABLE IF NOT EXISTS concept_graph.learner_concept_mastery (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    concept_id BIGINT NOT NULL REFERENCES concept_graph.concepts(id) ON DELETE CASCADE,
    mastery REAL NOT NULL DEFAULT 0.0 CHECK (mastery >= 0 AND mastery <= 1),
    attempts INT NOT NULL DEFAULT 0,
    last_score REAL,
    last_assessed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, concept_id)
  )
`;
console.log("  ✅ concept_graph.learner_concept_mastery");

await sql`CREATE INDEX IF NOT EXISTS idx_mastery_user ON concept_graph.learner_concept_mastery(user_id)`;
await sql`CREATE INDEX IF NOT EXISTS idx_mastery_concept ON concept_graph.learner_concept_mastery(concept_id)`;
console.log("  ✅ 2 indexes");

// Verify
console.log("\n--- Verification ---");
const tables = await sql`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'concept_graph'
  ORDER BY table_name
`;
console.log("Tables in concept_graph schema:");
for (const t of tables) {
  console.log(`  - ${t.table_name}`);
}

console.log("\n=== Migration 005 complete ===");
