import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ingestSource, contentHash, chunkLargeFile, validateSourceConfigs, draftReason, type SourceConfig } from "./ingest.js";

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
function makeMockSql(existingRows: { source_uri: string; content_hash: string }[], indexedFiles: string[] = []) {
  const transactionCalls: MockQuery[][] = [];
  const allQueries: MockQuery[] = [];

  function tag(strings: TemplateStringsArray, ...values: unknown[]) {
    const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ""), "");
    const type = classify(text);
    // The prune_missing lookup selects file names; every other select reads (source_uri, content_hash).
    const result = type !== "select" ? [] : /DISTINCT split_part/.test(text) ? indexedFiles.map((filename) => ({ filename })) : existingRows;
    const query: MockQuery = { text, type };
    allQueries.push(query);
    const promise = Promise.resolve(result) as Promise<unknown> & { __query: MockQuery };
    promise.__query = query;
    return promise;
  }

  tag.transaction = vi.fn(async (queries: (Promise<unknown> & { __query: MockQuery })[]) => {
    transactionCalls.push(queries.map((q) => q.__query));
    return Promise.all(queries);
  });

  return { sql: tag as unknown as Parameters<typeof ingestSource>[1], transactionCalls, allQueries };
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
    source_class: "personal",
    source_owner: "tseren",
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

  it("writes source_class/source_owner into the standalone INSERT (WP-596 Ф7)", async () => {
    writeFileSync(join(dir, "small.md"), "# Small\n\nSome standalone content.\n");
    const { sql, transactionCalls } = makeMockSql([]);

    await ingestSource(config({ source_class: "methodology", source_owner: "platform" }), sql, "fake-api-key");

    const [, , ins] = transactionCalls[0];
    expect(ins.text).toContain("methodology");
    expect(ins.text).toContain("platform");
  });
});

describe("validateSourceConfigs — class/owner required at indexing time (WP-596 Ф7)", () => {
  const baseConfig = (overrides: Partial<SourceConfig> = {}): SourceConfig => ({
    source: "valid-source",
    source_type: "ds",
    path: "/tmp/does-not-matter",
    source_class: "methodology",
    source_owner: "platform",
    ...overrides,
  });

  it("passes silently when every config has a valid class and a non-empty owner", () => {
    expect(() => validateSourceConfigs([baseConfig(), baseConfig({ source: "second" })])).not.toThrow();
  });

  it("throws when source_class is missing", () => {
    expect(() =>
      validateSourceConfigs([{ ...baseConfig(), source_class: undefined as unknown as SourceConfig["source_class"] }])
    ).toThrow(/source_class/);
  });

  it("throws when source_class is not one of the four allowed values", () => {
    expect(() =>
      validateSourceConfigs([{ ...baseConfig(), source_class: "bogus" as unknown as SourceConfig["source_class"] }])
    ).toThrow(/source_class/);
  });

  it("throws when source_owner is missing or empty", () => {
    expect(() => validateSourceConfigs([baseConfig({ source_owner: "" })])).toThrow(/source_owner/);
  });

  it("collects every invalid source in one error instead of stopping at the first", () => {
    expect(() =>
      validateSourceConfigs([
        { ...baseConfig({ source: "bad-one" }), source_owner: "" },
        { ...baseConfig({ source: "bad-two" }), source_class: undefined as unknown as SourceConfig["source_class"] },
      ])
    ).toThrow(/bad-one[\s\S]*bad-two/);
  });
});

describe("draftReason — two independent draft markers (WP-596 Ф10 п.5)", () => {
  it.each([
    ["status: draft", "---\nstatus: draft\n---\n\n# Post\n", "status"],
    ["status behind a BOM", "\uFEFF---\nstatus: draft\n---\n\n# Post\n", "status"],
    ["quoted status", '---\nstatus: "draft"\n---\n\n# Post\n', "status"],
    ["status in other case", "---\nstatus: Draft\n---\n\n# Post\n", "status"],
    ["draft-internal status", "---\nstatus: draft-internal\n---\n\n# Post\n", "status"],
    ["club category line", "# Мышление письмом\n\n**Категория:** Черновики|Церен Церенов (черновики)\n\n**Дата:** 2023-06-14\n", "category"],
    ["category line in other case", "# Post\n\n**Категория:** черновики\n", "category"],
  ] as const)("flags %s", (_name, content, reason) => {
    expect(draftReason(content)).toBe(reason);
  });

  it.each([
    ["published status", "---\nstatus: published\n---\n\n# Post\n"],
    ["ready status", "---\nstatus: ready\n---\n\n# Post\n"],
    ["other category", "# Post\n\n**Категория:** Статьи\n"],
    ["word 'draft' only in the body", "---\nstatus: published\n---\n\nThis is not a draft any more.\n"],
    ["category line deep in the body", "# Post\n" + "text\n".repeat(40) + "**Категория:** Черновики\n"],
    ["no frontmatter and no category", "# Plain document\n\nSome text.\n"],
  ])("does not flag %s", (_name, content) => {
    expect(draftReason(content)).toBeNull();
  });

  it("falls back to the category line when the frontmatter is malformed YAML", () => {
    expect(draftReason("---\nstatus: [draft\n---\n\n**Категория:** Черновики\n")).toBe("category");
    expect(draftReason("---\nstatus: [draft\n---\n\n# Post\n")).toBeNull();
  });
});

describe("validateSourceConfigs — exclude_drafts (WP-596 Ф10 п.5)", () => {
  const platform = (overrides: Partial<SourceConfig> = {}): SourceConfig => ({
    source: "kb", source_type: "content", path: "/x", source_class: "methodology", source_owner: "platform", ...overrides,
  });

  it("accepts exclude_drafts on a platform source", () => {
    expect(() => validateSourceConfigs([platform({ exclude_drafts: true })])).not.toThrow();
  });

  it("rejects exclude_drafts on a personal source (user_id set): the personal layer keeps drafts", () => {
    expect(() => validateSourceConfigs([platform({ exclude_drafts: true, user_id: "u-1" })])).toThrow(/только к платформенному слою/);
  });

  it("rejects a non-boolean exclude_drafts so a typo cannot silently disable the filter", () => {
    expect(() => validateSourceConfigs([platform({ exclude_drafts: "true" as unknown as boolean })])).toThrow(/true\/false/);
  });
});

describe("ingestSource — exclude_drafts purge (WP-596 Ф10 п.5)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wp596-drafts-test-"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, opts: { body: string }) => {
        const { input } = JSON.parse(opts.body) as { input: string[] };
        return { ok: true, status: 200, json: async () => ({ data: input.map(() => ({ embedding: [0.1, 0.2, 0.3] })) }) };
      })
    );
    writeFileSync(join(dir, "normal.md"), "# Published\n\n---\n\nPublished content long enough.\n");
    writeFileSync(join(dir, "draft-status.md"), "---\nstatus: draft\n---\n\n# Draft by status\n\nContent of a draft.\n");
    writeFileSync(join(dir, "club-post.md"), "# Club post\n\n**Категория:** Черновики|Автор (черновики)\n\nContent of a club post.\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  const config = (overrides: Partial<SourceConfig> = {}): SourceConfig => ({
    source: "kb", source_type: "content", path: dir, source_class: "methodology", source_owner: "platform", ...overrides,
  });
  const purgeQueries = (queries: MockQuery[]) => queries.filter((q) => q.type === "delete" && q.text.includes("RETURNING"));

  it("indexes only the non-draft file and deletes the rows of both drafts by explicit filename", async () => {
    const { sql, transactionCalls, allQueries } = makeMockSql([]);

    const indexed = await ingestSource(config({ exclude_drafts: true }), sql, "fake-api-key");

    expect(indexed).toBe(1);
    expect(transactionCalls).toHaveLength(1);
    expect(transactionCalls[0].some((q) => q.type === "insert" && q.text.includes("normal.md"))).toBe(true);
    const purge = purgeQueries(allQueries);
    expect(purge).toHaveLength(1);
    expect(purge[0].text).toContain("draft-status.md");
    expect(purge[0].text).toContain("club-post.md");
    expect(purge[0].text).not.toContain("normal.md");
    expect(purge[0].text).toContain("split_part(source_uri, '::', 1)"); // also removes the '::section' chunks
  });

  it("dry run counts the draft rows but deletes and indexes nothing", async () => {
    const { sql, transactionCalls, allQueries } = makeMockSql([]);

    const indexed = await ingestSource(config({ exclude_drafts: true }), sql, "fake-api-key", { dryRun: true });

    expect(indexed).toBe(0);
    expect(transactionCalls).toHaveLength(0);
    expect(allQueries.filter((q) => q.type === "delete")).toHaveLength(0);
    expect(allQueries.some((q) => q.type === "select" && q.text.includes("draft-status.md"))).toBe(true);
  });

  it("keeps drafts when the source has no exclude_drafts flag (personal layer, other repositories)", async () => {
    const { sql, transactionCalls, allQueries } = makeMockSql([]);

    const indexed = await ingestSource(config(), sql, "fake-api-key");

    expect(indexed).toBe(3);
    expect(transactionCalls).toHaveLength(3);
    expect(purgeQueries(allQueries)).toHaveLength(0);
  });

  it("deletes nothing when no file is a draft", async () => {
    rmSync(join(dir, "draft-status.md"));
    rmSync(join(dir, "club-post.md"));
    const { sql, allQueries } = makeMockSql([]);

    await ingestSource(config({ exclude_drafts: true }), sql, "fake-api-key");

    expect(purgeQueries(allQueries)).toHaveLength(0);
  });
});

describe("validateSourceConfigs — prune_missing (WP-596 Ф10 п.5)", () => {
  const platform = (overrides: Partial<SourceConfig> = {}): SourceConfig => ({
    source: "kb", source_type: "content", path: "/x", source_class: "methodology", source_owner: "platform", ...overrides,
  });

  it("accepts prune_missing on a platform source", () => {
    expect(() => validateSourceConfigs([platform({ prune_missing: true })])).not.toThrow();
  });

  it("rejects prune_missing on a personal source (user_id set)", () => {
    expect(() => validateSourceConfigs([platform({ prune_missing: true, user_id: "u-1" })])).toThrow(/prune_missing применим только/);
  });

  it("rejects a non-boolean prune_missing", () => {
    expect(() => validateSourceConfigs([platform({ prune_missing: "yes" as unknown as boolean })])).toThrow(/prune_missing должен быть true\/false/);
  });
});

describe("ingestSource — prune_missing (WP-596 Ф10 п.5)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wp596-prune-test-"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, opts: { body: string }) => {
        const { input } = JSON.parse(opts.body) as { input: string[] };
        return { ok: true, status: 200, json: async () => ({ data: input.map(() => ({ embedding: [0.1, 0.2, 0.3] })) }) };
      })
    );
    writeFileSync(join(dir, "normal.md"), "# Published\n\nPublished content long enough.\n");
    writeFileSync(join(dir, "draft-status.md"), "---\nstatus: draft\n---\n\n# Draft\n\nContent of a draft.\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const config = (overrides: Partial<SourceConfig> = {}): SourceConfig => ({
    source: "kb", source_type: "content", path: dir, source_class: "methodology", source_owner: "platform",
    exclude_drafts: true, prune_missing: true, ...overrides,
  });
  const returningDeletes = (queries: MockQuery[]) => queries.filter((q) => q.type === "delete" && q.text.includes("RETURNING"));
  const pruneDelete = (queries: MockQuery[], name: string) => returningDeletes(queries).filter((q) => q.text.includes(name));

  it("deletes the rows of files that are on neither side of the scan, and only those", async () => {
    // normal.md and draft-status.md are scanned; gone.md was indexed earlier and no longer exists.
    const { sql, allQueries } = makeMockSql([], ["normal.md", "draft-status.md", "gone.md"]);

    await ingestSource(config(), sql, "fake-api-key", { pruneMaxRatio: 0.5 });

    const prune = pruneDelete(allQueries, "gone.md");
    expect(prune).toHaveLength(1);
    expect(prune[0].text).not.toContain("normal.md");
    expect(prune[0].text).not.toContain("draft-status.md");
  });

  it("refuses to prune when too much of the indexed set is missing from the scan (wrong path, half-mounted dir)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sql, allQueries } = makeMockSql([], ["normal.md", "gone-1.md", "gone-2.md"]); // 2 of 3 missing, default limit 20 %

    await ingestSource(config(), sql, "fake-api-key");

    expect(pruneDelete(allQueries, "gone-1.md")).toHaveLength(0);
    expect(errors.mock.calls.flat().join("\n")).toContain("prune_missing skipped");
  });

  it("still indexes the scanned files when the prune is refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { sql, transactionCalls } = makeMockSql([], ["normal.md", "gone-1.md", "gone-2.md"]);

    const indexed = await ingestSource(config(), sql, "fake-api-key");

    expect(indexed).toBe(1);
    expect(transactionCalls).toHaveLength(1);
  });

  it("does not even read the indexed file names without the flag", async () => {
    const { sql, allQueries } = makeMockSql([], ["normal.md", "gone.md"]);

    await ingestSource(config({ prune_missing: false }), sql, "fake-api-key");

    expect(allQueries.some((q) => /DISTINCT split_part/.test(q.text))).toBe(false);
    expect(pruneDelete(allQueries, "gone.md")).toHaveLength(0);
  });

  it("dry run lists the missing files but deletes nothing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { sql, allQueries } = makeMockSql([], ["normal.md", "draft-status.md", "gone.md"]);

    await ingestSource(config(), sql, "fake-api-key", { dryRun: true, pruneMaxRatio: 0.5 });

    expect(allQueries.filter((q) => q.type === "delete")).toHaveLength(0);
    expect(log.mock.calls.flat().join("\n")).toContain("Missing (first 20): gone.md");
  });

  it("deletes nothing when every indexed file is still on disk", async () => {
    const { sql, allQueries } = makeMockSql([], ["normal.md", "draft-status.md"]);

    await ingestSource(config(), sql, "fake-api-key");

    expect(pruneDelete(allQueries, "normal.md")).toHaveLength(0);
    // the only RETURNING delete is the draft purge of draft-status.md
    expect(returningDeletes(allQueries)).toHaveLength(1);
  });
});
