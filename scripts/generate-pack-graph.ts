#!/usr/bin/env npx tsx
/**
 * Pack Graph Exporter — WP-338 Ф6
 *
 * Exports the artifact/concept subgraph from Neon PostgreSQL to:
 *   1. JSON (node-link, D3-compatible)
 *   2. GraphML (Gephi/yEd/Cytoscape)
 *   3. DOT (Graphviz)
 *
 * Usage:
 *   npx tsx scripts/generate-pack-graph.ts
 *   npx tsx scripts/generate-pack-graph.ts --format json        # JSON only
 *   npx tsx scripts/generate-pack-graph.ts --format graphml     # GraphML only
 *   npx tsx scripts/generate-pack-graph.ts --format dot         # DOT only
 *   npx tsx scripts/generate-pack-graph.ts --node-type artifact # artifact nodes only
 *   npx tsx scripts/generate-pack-graph.ts --node-type all      # all nodes (default)
 *   npx tsx scripts/generate-pack-graph.ts --edge-types pack_cites,artifact_defines_concept
 *   npx tsx scripts/generate-pack-graph.ts --output ./output/my-graph
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { neon } from "@neondatabase/serverless";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .dev.vars if env vars not set
if (!process.env.DATABASE_URL) {
  const devVarsPath = join(__dirname, "../.dev.vars");
  if (existsSync(devVarsPath)) {
    const vars = readFileSync(devVarsPath, "utf-8");
    for (const line of vars.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.+)/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].trim();
      }
    }
  }
}

// --- CLI Args ---

const args = process.argv.slice(2);
const FORMAT = parseArg("--format", "all") as "all" | "json" | "graphml" | "dot";
const NODE_TYPE_FILTER = parseArg("--node-type", "all") as "all" | "artifact" | "concept";
const EDGE_TYPES_ARG = parseArg("--edge-types", "all");
const OUTPUT_BASE = parseArg("--output", join(__dirname, "../output/pack-graph"));

function parseArg(flag: string, defaultVal: string): string {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const EDGE_TYPES = EDGE_TYPES_ARG === "all"
  ? ["pack_cites", "pack_depends_on", "pack_extends", "pack_implements", "artifact_defines_concept"]
  : EDGE_TYPES_ARG.split(",").map((s) => s.trim());

// --- DB ---

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("DATABASE_URL not found in env or .dev.vars");
  process.exit(1);
}

const sql = neon(dbUrl);

// --- Types ---

interface DbNode {
  id: number;
  code: string | null;
  name: string;
  level: string;
  domain: string | null;
  node_type: string;
}

interface DbEdge {
  from_concept_id: number;
  to_concept_id: number;
  edge_type: string;
  weight: number;
}

interface GraphNode {
  id: string;
  label: string;
  type: string;
  level: string;
  domain: string | null;
}

interface GraphEdge {
  source: string;
  target: string;
  type: string;
  weight: number;
}

interface GraphJson {
  directed: boolean;
  multigraph: boolean;
  graph: {
    generated_at: string;
    node_count: number;
    edge_count: number;
    edge_type_breakdown: Record<string, number>;
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// --- Main ---

async function main() {
  console.log("🔌 Connecting to DB...");

  // 1. Fetch nodes
  const allDbNodes = await sql`
    SELECT id, code, name, level, domain, node_type
    FROM concept_graph.concepts
    ORDER BY id
  ` as DbNode[];

  const dbNodes = NODE_TYPE_FILTER === "all"
    ? allDbNodes
    : allDbNodes.filter((n) => n.node_type === NODE_TYPE_FILTER);
  console.log(`📦 Nodes loaded: ${dbNodes.length}`);

  // 2. Fetch edges
  const dbEdges = await sql`
    SELECT e.from_concept_id, e.to_concept_id, e.edge_type, e.weight
    FROM concept_graph.concept_edges e
    WHERE e.edge_type = ANY(${EDGE_TYPES}::text[])
    ORDER BY e.from_concept_id, e.to_concept_id
  ` as DbEdge[];
  console.log(`🔗 Edges loaded: ${dbEdges.length}`);

  // 3. Build id→code map for both directions
  const codeById = new Map<number, string>();
  const nameById = new Map<number, string>();
  const metaById = new Map<number, DbNode>();
  for (const n of dbNodes) {
    codeById.set(n.id, n.code || `node-${n.id}`);
    nameById.set(n.id, n.name);
    metaById.set(n.id, n);
  }

  // 4. Filter edges to only those where both endpoints exist in our node set
  const validNodeIds = new Set(dbNodes.map((n) => n.id));
  const validEdges = dbEdges.filter(
    (e) => validNodeIds.has(e.from_concept_id) && validNodeIds.has(e.to_concept_id)
  );
  console.log(`🔗 Valid edges (both endpoints present): ${validEdges.length}`);

  // 5. Build edge type breakdown
  const edgeTypeBreakdown: Record<string, number> = {};
  for (const e of validEdges) {
    edgeTypeBreakdown[e.edge_type] = (edgeTypeBreakdown[e.edge_type] || 0) + 1;
  }

  // 6. Build graph structures
  const nodes: GraphNode[] = dbNodes.map((n) => ({
    id: n.code || `node-${n.id}`,
    label: n.name,
    type: n.node_type,
    level: n.level,
    domain: n.domain,
  }));

  const edges: GraphEdge[] = validEdges.map((e) => ({
    source: codeById.get(e.from_concept_id)!,
    target: codeById.get(e.to_concept_id)!,
    type: e.edge_type,
    weight: e.weight,
  }));

  const graphJson: GraphJson = {
    directed: true,
    multigraph: true,
    graph: {
      generated_at: new Date().toISOString(),
      node_count: nodes.length,
      edge_count: edges.length,
      edge_type_breakdown: edgeTypeBreakdown,
    },
    nodes,
    edges,
  };

  // 7. Ensure output dir exists
  const outputDir = dirname(OUTPUT_BASE);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // 8. Write outputs
  if (FORMAT === "all" || FORMAT === "json") {
    const path = `${OUTPUT_BASE}.json`;
    writeFileSync(path, JSON.stringify(graphJson, null, 2), "utf-8");
    console.log(`✅ JSON written: ${path} (${(readFileSync(path).length / 1024).toFixed(1)} KB)`);
  }

  if (FORMAT === "all" || FORMAT === "graphml") {
    const path = `${OUTPUT_BASE}.graphml`;
    writeFileSync(path, toGraphML(nodes, edges), "utf-8");
    console.log(`✅ GraphML written: ${path} (${(readFileSync(path).length / 1024).toFixed(1)} KB)`);
  }

  if (FORMAT === "all" || FORMAT === "dot") {
    const path = `${OUTPUT_BASE}.dot`;
    writeFileSync(path, toDOT(nodes, edges), "utf-8");
    console.log(`✅ DOT written: ${path} (${(readFileSync(path).length / 1024).toFixed(1)} KB)`);
  }

  console.log("\n📊 Summary:");
  console.log(`   Nodes: ${nodes.length} (${NODE_TYPE_FILTER})`);
  console.log(`   Edges: ${edges.length} (${EDGE_TYPES.join(", ")})`);
  console.log(`   Edge breakdown:`, edgeTypeBreakdown);
}

// --- Serializers ---

function toGraphML(nodes: GraphNode[], edges: GraphEdge[]): string {
  const header = `<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">
  <key id="label" for="node" attr.name="label" attr.type="string"/>
  <key id="type" for="node" attr.name="type" attr.type="string"/>
  <key id="level" for="node" attr.name="level" attr.type="string"/>
  <key id="domain" for="node" attr.name="domain" attr.type="string"/>
  <key id="edgeType" for="edge" attr.name="edgeType" attr.type="string"/>
  <key id="weight" for="edge" attr.name="weight" attr.type="double"/>
  <graph id="pack-graph" edgedefault="directed">
`;

  const nodeLines = nodes
    .map(
      (n) =>
        `    <node id="${escapeXml(n.id)}">\n` +
        `      <data key="label">${escapeXml(n.label)}</data>\n` +
        `      <data key="type">${escapeXml(n.type)}</data>\n` +
        `      <data key="level">${escapeXml(n.level)}</data>\n` +
        `      <data key="domain">${escapeXml(n.domain || "")}</data>\n` +
        `    </node>`
    )
    .join("\n");

  const edgeLines = edges
    .map(
      (e, i) =>
        `    <edge id="e${i}" source="${escapeXml(e.source)}" target="${escapeXml(e.target)}">\n` +
        `      <data key="edgeType">${escapeXml(e.type)}</data>\n` +
        `      <data key="weight">${e.weight}</data>\n` +
        `    </edge>`
    )
    .join("\n");

  const footer = `
  </graph>
</graphml>`;

  return header + nodeLines + "\n" + edgeLines + footer;
}

function toDOT(nodes: GraphNode[], edges: GraphEdge[]): string {
  const nodeLines = nodes
    .map((n) => {
      const label = n.label.length > 40 ? n.label.slice(0, 37) + "..." : n.label;
      const color = n.type === "artifact" ? "lightblue" : "lightyellow";
      return `  "${escapeDot(n.id)}" [label="${escapeDot(label)}\n(${n.type})", style=filled, fillcolor=${color}];`;
    })
    .join("\n");

  const edgeLines = edges
    .map((e) => {
      const color =
        e.type === "artifact_defines_concept"
          ? "green"
          : e.type === "pack_cites"
          ? "blue"
          : e.type === "pack_depends_on"
          ? "red"
          : "gray";
      return `  "${escapeDot(e.source)}" -> "${escapeDot(e.target)}" [label="${escapeDot(e.type)}", color=${color}, fontcolor=${color}];`;
    })
    .join("\n");

  return `digraph PackGraph {\n  rankdir=LR;\n  node [shape=box, fontname="Helvetica"];\n  edge [fontname="Helvetica", fontsize=10];\n\n${nodeLines}\n\n${edgeLines}\n}`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeDot(s: string): string {
  return s.replace(/"/g, '\\"');
}

// --- Run ---

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
