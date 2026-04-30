# Schema Parameterization for Knowledge MCP Migrations

WP-268 Phase 3: Support parameterized schema names in migrations for flexible database deployment.

## Overview

Knowledge MCP migrations previously used hardcoded schema names (e.g., `knowledge.documents`, `concept_graph.concepts`, `health.graph_usage_events`). This tool enables parameter-driven schema deployment across different database environments (dev, staging, production).

## Usage

### 1. Parameterize Migration Files

Use the `parameterize-schema.ts` script to replace hardcoded schema names with environment variables:

```bash
# Dry run (show what would change)
npx ts-node scripts/parameterize-schema.ts --dry-run

# Apply parameterization
npx ts-node scripts/parameterize-schema.ts

# Custom output directory
npx ts-node scripts/parameterize-schema.ts --output-dir ./migrations-staging

# Override schema names
npx ts-node scripts/parameterize-schema.ts \
  --knowledge-schema "kn_prod" \
  --concept-schema "cg_prod" \
  --health-schema "h_prod"
```

### 2. Environment Variables

Control schema names via environment variables when applying migrations:

```bash
# Default schemas (knowledge, concept_graph, health)
psql "$KNOWLEDGE_DATABASE_URL" -f migrations/001-hybrid-search.sql

# Custom schemas
export KNOWLEDGE_DB_SCHEMA="kn_staging"
export CONCEPT_GRAPH_DB_SCHEMA="cg_staging"
export HEALTH_DB_SCHEMA="h_staging"
psql "$KNOWLEDGE_DATABASE_URL" -f migrations-parameterized/001-hybrid-search.sql
```

### 3. Supported Patterns

The tool replaces:

| Pattern | Replacement |
|---------|-------------|
| `knowledge.table_name` | `${KNOWLEDGE_SCHEMA}.table_name` |
| `concept_graph.table_name` | `${CONCEPT_GRAPH_SCHEMA}.table_name` |
| `health.table_name` | `${HEALTH_SCHEMA}.table_name` |
| `CREATE SCHEMA IF NOT EXISTS knowledge` | `CREATE SCHEMA IF NOT EXISTS ${KNOWLEDGE_SCHEMA}` |
| `CREATE SCHEMA IF NOT EXISTS concept_graph` | `CREATE SCHEMA IF NOT EXISTS ${CONCEPT_GRAPH_SCHEMA}` |
| `CREATE SCHEMA IF NOT EXISTS health` | `CREATE SCHEMA IF NOT EXISTS ${HEALTH_SCHEMA}` |

### 4. Direct SQL Variable Substitution

If you prefer direct substitution in shell before running `psql`:

```bash
# Replace variables in migration before executing
sed -e "s/\${KNOWLEDGE_SCHEMA}/kn_prod/g" \
    -e "s/\${CONCEPT_GRAPH_SCHEMA}/cg_prod/g" \
    -e "s/\${HEALTH_SCHEMA}/h_prod/g" \
    migrations/001-hybrid-search.sql | psql "$KNOWLEDGE_DATABASE_URL"
```

## Backward Compatibility

- **Default behavior unchanged**: Without environment variables, migrations use original schema names (`knowledge`, `concept_graph`, `health`).
- **Existing migrations**: Can be parameterized incrementally. Old (hardcoded) and new (parameterized) migrations coexist.

## Integration with Knowledge MCP Codebase

Runtime code (TypeScript) also supports schema parameterization via environment variables:

```typescript
// Set environment variables
process.env.KNOWLEDGE_DB_SCHEMA = "kn_staging";
process.env.CONCEPT_GRAPH_DB_SCHEMA = "cg_staging";
process.env.HEALTH_DB_SCHEMA = "h_staging";

// Access via utilities (personal-knowledge-mcp, knowledge-mcp)
import { getKnowledgeSchema, getConceptGraphSchema } from "./utils/db";
const schema = getKnowledgeSchema(env);
const table = `${schema}.documents`;
```

## Wrangler Configuration (CF Workers)

In `wrangler.toml` or via `wrangler secret`:

```toml
[env.staging]
vars = { KNOWLEDGE_DB_SCHEMA = "kn_staging", CONCEPT_GRAPH_DB_SCHEMA = "cg_staging", HEALTH_DB_SCHEMA = "h_staging" }

[env.production]
vars = { KNOWLEDGE_DB_SCHEMA = "knowledge", CONCEPT_GRAPH_DB_SCHEMA = "concept_graph", HEALTH_DB_SCHEMA = "health" }
```

Deploy to specific environment:

```bash
wrangler deploy --env staging
```

## Testing

1. **Test parameterization script**:
   ```bash
   npx ts-node scripts/parameterize-schema.ts --dry-run
   ```

2. **Test migrations on dev database**:
   ```bash
   # Apply to custom schema
   export KNOWLEDGE_DB_SCHEMA="test_kn"
   export CONCEPT_GRAPH_DB_SCHEMA="test_cg"
   export HEALTH_DB_SCHEMA="test_h"
   psql "$DEV_DB_URL" -f migrations-parameterized/001-hybrid-search.sql
   ```

3. **Verify schema creation**:
   ```bash
   psql "$DEV_DB_URL" -c "\dn" # List schemas
   psql "$DEV_DB_URL" -c "SELECT * FROM test_kn.documents LIMIT 1;"
   ```

## Notes

- Script is idempotent: running multiple times produces identical output.
- Variable markers (`${KNOWLEDGE_SCHEMA}`, etc.) are preserved for SQL interpretation (no immediate substitution in parameterize script).
- Migrations must be executed with environment variables set, or pre-processed with `sed` before `psql`.
