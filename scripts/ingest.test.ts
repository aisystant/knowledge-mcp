import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ingestSource, contentHash, chunkLargeFile, type SourceConfig } from "./ingest.js";

type MockQuery = { text: string; type: "select" | "delete" | "insert" | "lock" };

function classify(text: string): MockQuery["type"] {
  if (/pg_advisory_xact_lock/.test(text)) return "lock";
  if (/^\s*DELETE/.test(text)) return "delete";
  if (/^\s*INSERT/.test(text)) return "insert";
  return "select";
}

// Minimal stand-in for @neondatabase/serverless's tagged-template `sql` function:
// each call returns a thenable carrying its own query text/type, and `.transaction()`
// records the array it received (order + membership) before resolving each entry.
function makeMockSql(existingRows: { source_uri: string; content_hash: string }[]) {
  const transactionCalls: MockQuery[][] = [];

  function tag(strings: TemplateStringsArray, ...values: unknown[]) {
    const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ""), "");
    const type = classify(text);
    const result = type === "select" ? existingRows : [];
    const query: MockQuery = { text, type };
    const promise = Promise.resolve(result) as Promise<unknown> & { __query: MockQuery };
    promise.__query = query;
    return promise;
  }

  tag.transaction = vi.fn(async (queries: (Promise<unknown> & { __query: MockQuery })[]) => {
    transactionCalls.push(queries.map((q) => q.__query));
    return Promise.all(queries);
  });

  return { sql: tag as unknown as Parameters<typeof ingestSource>[1], transactionCalls };
}

describe("ingestSource — transactional DELETE+INSERT (WP-443)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wp443-ingest-test-"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, opts: { body: string }) => {
        const { input } = JSON.parse(opts.body) as { input: string[] };
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: input.map(() => ({ embedding: [0.1, 0.2, 0.3] })) }),
        };
      })
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  const config = (overrides: Partial<SourceConfig> = {}): SourceConfig => ({
    source: "wp443-test",
    source_type: "ds",
    path: dir,
    ...overrides,
  });

  it("runs the advisory lock, then DELETE, then INSERT — in that order, in one transaction", async () => {
    writeFileSync(join(dir, "small.md"), "# Small\n\nSome standalone content.\n");
    const { sql, transactionCalls } = makeMockSql([]);

    const indexed = await ingestSource(config(), sql, "fake-api-key");

    expect(indexed).toBe(1);
    expect(transactionCalls).toHaveLength(1);
    const [lock, del, ins] = transactionCalls[0];
    expect(lock.type).toBe("lock");
    expect(del.type).toBe("delete");
    expect(ins.type).toBe("insert");
  });

  it("re-inserts the parent row when only a child chunk changed (parent content itself unchanged)", async () => {
    const content =
      "# Big doc\n\n" +
      "## Section 1\n\n" +
      "Lorem ipsum ".repeat(50) +
      "\n\n## Section 2\n\n" +
      "Dolor sit amet ".repeat(1500); // pushes the file past CHUNK_CHAR_LIMIT so it's chunked into parent+children
    writeFileSync(join(dir, "big.md"), content);

    const parentHash = contentHash(content);
    const realChunks = chunkLargeFile(content, "big.md");
    expect(realChunks.length).toBeGreaterThan(0);

    // Existing DB state: parent hash matches current content (unchanged), but the
    // first child chunk's hash is stale (changed) — this used to mean the parent
    // was excluded from `toIndex` while the cascade DELETE still removed its row,
    // permanently losing the parent document (WP-443 review finding).
    const existingRows = [
      { source_uri: "big.md", content_hash: parentHash },
      { source_uri: realChunks[0].filename, content_hash: "stale-hash-does-not-match" },
    ];
    const { sql, transactionCalls } = makeMockSql(existingRows);

    await ingestSource(config(), sql, "fake-api-key");

    const parentUnit = transactionCalls.find((calls) =>
      calls.some((q) => q.type === "delete" && q.text.includes("big.md"))
    );
    expect(parentUnit).toBeDefined();
    const parentInsert = parentUnit!.find(
      (q) => q.type === "insert" && q.text.includes("paragraph_pos") && q.text.includes("chunk_uuid")
    );
    expect(parentInsert).toBeDefined();
  });

  it("continues indexing remaining units when one unit's transaction fails", async () => {
    writeFileSync(join(dir, "a.md"), "# Doc A\n\nContent A.\n");
    writeFileSync(join(dir, "b.md"), "# Doc B\n\nContent B.\n");
    const { sql, transactionCalls } = makeMockSql([]);
    let call = 0;
    (sql as unknown as { transaction: ReturnType<typeof vi.fn> }).transaction = vi.fn(
      async (queries: (Promise<unknown> & { __query: MockQuery })[]) => {
        call += 1;
        transactionCalls.push(queries.map((q) => q.__query));
        if (call === 1) throw new Error("simulated Neon HTTP failure");
        return Promise.all(queries);
      }
    );

    const indexed = await ingestSource(config(), sql, "fake-api-key");

    expect(transactionCalls).toHaveLength(2); // both units attempted
    expect(indexed).toBe(1); // only the surviving unit counted
  });
});
