/**
 * Schema Parameterization CLI Tool for Knowledge MCP Migrations
 *
 * Reads migration SQL files and replaces hardcoded schema names with parameterized versions.
 * Supports environment variables: KNOWLEDGE_DB_SCHEMA, CONCEPT_GRAPH_DB_SCHEMA, HEALTH_DB_SCHEMA
 *
 * Usage:
 *   npx ts-node scripts/parameterize-schema.ts [options]
 *
 * Options:
 *   --input-dir     Path to migrations directory (default: ./migrations)
 *   --output-dir    Path to output directory (default: ./migrations-parameterized)
 *   --knowledge-schema     Knowledge schema name (default: 'knowledge' or env.KNOWLEDGE_DB_SCHEMA)
 *   --concept-schema       Concept graph schema name (default: 'concept_graph' or env.CONCEPT_GRAPH_DB_SCHEMA)
 *   --health-schema        Health schema name (default: 'health' or env.HEALTH_DB_SCHEMA)
 *   --dry-run       Only show what would be changed (don't write)
 */

import * as fs from "fs";
import * as path from "path";

interface SchemaConfig {
  knowledge: string;
  conceptGraph: string;
  health: string;
}

function parseArgs(): { inputDir: string; outputDir: string; schemas: SchemaConfig; dryRun: boolean } {
  const args = process.argv.slice(2);
  let inputDir = "./migrations";
  let outputDir = "./migrations-parameterized";
  let dryRun = false;

  const schemas: SchemaConfig = {
    knowledge: process.env.KNOWLEDGE_DB_SCHEMA || "knowledge",
    conceptGraph: process.env.CONCEPT_GRAPH_DB_SCHEMA || "concept_graph",
    health: process.env.HEALTH_DB_SCHEMA || "health",
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input-dir") inputDir = args[++i];
    if (args[i] === "--output-dir") outputDir = args[++i];
    if (args[i] === "--knowledge-schema") schemas.knowledge = args[++i];
    if (args[i] === "--concept-schema") schemas.conceptGraph = args[++i];
    if (args[i] === "--health-schema") schemas.health = args[++i];
    if (args[i] === "--dry-run") dryRun = true;
  }

  return { inputDir, outputDir, schemas, dryRun };
}

/**
 * Replace hardcoded schema names with parameterized versions.
 * Replaces patterns like:
 *   - knowledge.table → ${KNOWLEDGE_SCHEMA}.table
 *   - concept_graph.table → ${CONCEPT_GRAPH_SCHEMA}.table
 *   - health.table → ${HEALTH_SCHEMA}.table
 *   - CREATE SCHEMA knowledge → CREATE SCHEMA ${KNOWLEDGE_SCHEMA}
 *   - CREATE SCHEMA concept_graph → CREATE SCHEMA ${CONCEPT_GRAPH_SCHEMA}
 */
function parameterizeSql(sql: string, schemas: SchemaConfig): { modified: boolean; output: string; changes: string[] } {
  const changes: string[] = [];
  let modified = false;
  let output = sql;

  // Replace schema-qualified table references
  const patterns = [
    {
      pattern: /\bknowledge\.(\w+)/gi,
      replacement: `\${KNOWLEDGE_SCHEMA}.$1`,
      name: "knowledge.table",
    },
    {
      pattern: /\bconcept_graph\.(\w+)/gi,
      replacement: `\${CONCEPT_GRAPH_SCHEMA}.$1`,
      name: "concept_graph.table",
    },
    {
      pattern: /\bhealth\.(\w+)/gi,
      replacement: `\${HEALTH_SCHEMA}.$1`,
      name: "health.table",
    },
    // CREATE SCHEMA directives
    {
      pattern: /CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS\s+knowledge\b/gi,
      replacement: `CREATE SCHEMA IF NOT EXISTS \${KNOWLEDGE_SCHEMA}`,
      name: "CREATE SCHEMA knowledge",
    },
    {
      pattern: /CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS\s+concept_graph\b/gi,
      replacement: `CREATE SCHEMA IF NOT EXISTS \${CONCEPT_GRAPH_SCHEMA}`,
      name: "CREATE SCHEMA concept_graph",
    },
    {
      pattern: /CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS\s+health\b/gi,
      replacement: `CREATE SCHEMA IF NOT EXISTS \${HEALTH_SCHEMA}`,
      name: "CREATE SCHEMA health",
    },
  ];

  for (const { pattern, replacement, name } of patterns) {
    const matches = output.match(pattern);
    if (matches) {
      changes.push(`  - ${name}: ${matches.length} occurrence(s)`);
      output = output.replace(pattern, replacement);
      modified = true;
    }
  }

  return { modified, output, changes };
}

async function main() {
  const { inputDir, outputDir, schemas, dryRun } = parseArgs();

  console.log(`\n📦 Knowledge MCP Migration Schema Parameterization`);
  console.log(`\n📋 Configuration:`);
  console.log(`  Input directory:  ${inputDir}`);
  console.log(`  Output directory: ${outputDir}`);
  console.log(`  Knowledge schema: ${schemas.knowledge}`);
  console.log(`  Concept schema:   ${schemas.conceptGraph}`);
  console.log(`  Health schema:    ${schemas.health}`);
  console.log(`  Dry run:          ${dryRun ? "YES" : "NO"}\n`);

  if (!fs.existsSync(inputDir)) {
    console.error(`❌ Input directory not found: ${inputDir}`);
    process.exit(1);
  }

  if (!dryRun && !fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`✅ Created output directory: ${outputDir}\n`);
  }

  const files = fs
    .readdirSync(inputDir)
    .filter(f => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log(`⚠️  No SQL files found in ${inputDir}`);
    return;
  }

  console.log(`📂 Found ${files.length} migration file(s):\n`);

  let totalModified = 0;

  for (const file of files) {
    const filePath = path.join(inputDir, file);
    const sql = fs.readFileSync(filePath, "utf-8");
    const { modified, output, changes } = parameterizeSql(sql, schemas);

    if (modified || changes.length > 0) {
      console.log(`  ✏️  ${file}`);
      for (const change of changes) {
        console.log(change);
      }

      if (!dryRun) {
        const outPath = path.join(outputDir, file);
        fs.writeFileSync(outPath, output, "utf-8");
        console.log(`      → Wrote to ${path.relative(process.cwd(), outPath)}`);
      }
      totalModified++;
    } else {
      console.log(`  ✓ ${file} (no changes needed)`);
    }
  }

  console.log(`\n${dryRun ? "📋 Would modify" : "✅ Modified"} ${totalModified}/${files.length} file(s)`);

  if (dryRun) {
    console.log(`\n💡 To apply changes, run without --dry-run:`);
    console.log(`   npx ts-node scripts/parameterize-schema.ts`);
  }
}

main().catch(err => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
