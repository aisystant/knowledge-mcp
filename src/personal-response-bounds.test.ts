import { describe, expect, it } from "vitest";
import { buildPrivateDocumentResponse, buildPrivateSearchResponse, enforcePrivateReadBudget, privateReadIdError, privateResponseBytes, PRIVATE_READ_RESPONSE_BUDGET_BYTES, validateDocumentPageRequest } from "./personal-response-bounds.js";

type Response = ReturnType<typeof buildPrivateSearchResponse>;
const result = (response: Response) => response.result as { content: { text: string }[]; isError?: boolean };
const data = (response: Response) => JSON.parse(result(response).content[0].text);
const doc = { filename: "notes/synthetic.md", source: "synthetic-source", content: "small text" };
const indexed = { userId: "synthetic-user", live: false };

function assertBounded(response: Response) {
  // Independent check on the actual serialized response, including nested JSON escaping.
  expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThanOrEqual(PRIVATE_READ_RESPONSE_BUDGET_BYTES);
}

function alterCursor(cursor: string, change: Record<string, unknown>): string {
  const fields = JSON.parse(Buffer.from(cursor.slice(3), "base64url").toString());
  return "d1." + Buffer.from(JSON.stringify({ ...fields, ...change })).toString("base64url");
}

describe("private search response bounds", () => {
  it("keeps small search bytes and all routing fields unchanged", () => {
    const hits = [{ ...doc, source_type: "ds", score: 0.9, github_url: null }];
    expect(buildPrivateSearchResponse(1, hits)).toEqual({ jsonrpc: "2.0", id: 1, result: {
      content: [{ type: "text", text: JSON.stringify(hits, null, 2) }],
    } });
  });

  it("fits twenty unicode/escaped hits plus degradation without dropping or reordering hits", () => {
    const hits = Array.from({ length: 20 }, (_, i) => ({ ...doc, filename: `note-${i}.md`,
      content: '😀Яe\u0301\r\n"\\'.repeat(4_000), score: 1 - i / 100, github_url: `https://example.test/${i}` }));
    const diagnostic = { error: "dependency_access_denied", stage: "embeddings", status: 403 };
    const response = buildPrivateSearchResponse('request-"\\', hits, diagnostic);
    assertBounded(response);
    const returned = data(response);
    expect(returned).toHaveLength(20);
    expect(returned.map((hit: typeof doc) => hit.filename)).toEqual(hits.map(hit => hit.filename));
    returned.forEach((hit: typeof hits[number] & { content_truncated: boolean }, i: number) => {
      expect({ ...hit, content: hits[i].content, content_truncated: undefined }).toEqual({ ...hits[i], content_truncated: undefined });
      expect(hit.content_truncated).toBe(true);
      expect(hit.content).toContain("use get_document");
      expect(hit.content).not.toMatch(/[\ud800-\udbff]\n/);
    });
    expect(JSON.parse(result(response).content[1].text).diagnostic).toEqual(diagnostic);
    expect(result(response).isError).toBeUndefined();
  });

  it("refuses oversized metadata explicitly instead of returning a partial or empty list", () => {
    const response = buildPrivateSearchResponse(1, [{ ...doc, filename: "名".repeat(40_000) }]);
    assertBounded(response);
    expect(result(response).isError).toBe(true);
    expect(data(response).error).toBe("response_too_large");
  });

  it("bounds errors and giant ids too", () => {
    const response = enforcePrivateReadBudget({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "x".repeat(100_000) } });
    assertBounded(response);
    expect(result(response).isError).toBe(true);
    const idError = privateReadIdError("x".repeat(40_000))!;
    assertBounded(idError);
    expect(idError).toMatchObject({ id: null, error: { code: -32600 } });
  });
});

describe("private document continuation", () => {
  it("preserves each small legacy response shape", async () => {
    expect(result(await buildPrivateDocumentResponse(1, doc, indexed)).content[0].text).toBe(doc.content);
    const liveDoc = { ...doc, sha: "a".repeat(40) };
    expect(data(await buildPrivateDocumentResponse(1, liveDoc, { ...indexed, live: true, ref: "main" })))
      .toEqual({ filename: doc.filename, source: doc.source, sha: liveDoc.sha, ref: "main", content: doc.content });
    expect(data(await buildPrivateDocumentResponse(1, doc, { ...indexed, headings: [{ level: 1, title: "Title" }] })))
      .toEqual({ filename: doc.filename, headings: [{ level: 1, title: "Title" }] });
  });

  it.each([false, true])("never gives a partial legacy success before opt-in (live=%s)", async live => {
    const response = await buildPrivateDocumentResponse(1, { ...doc, content: "secret-synthetic".repeat(8_000), sha: "a".repeat(40) }, { ...indexed, live });
    assertBounded(response);
    expect(result(response).isError).toBe(true);
    expect(data(response).error).toBe("response_too_large");
    expect(JSON.stringify(response)).not.toContain("secret-synthetic");
    expect(data(response).message).toContain("cursor:'start'");
  });

  it.each([false, true])("round-trips exact unicode/CRLF/escaped content across pages (live=%s)", async live => {
    const original = { ...doc, content: 'start\r\n' + '😀Яe\u0301\r\n"\\'.repeat(10_000), ...(live ? { sha: "a".repeat(40) } : {}) };
    let cursor: string | null = "start";
    let combined = "";
    let pages = 0;
    let revision: string | undefined;
    const cursors = new Set<string>();
    do {
      const response = await buildPrivateDocumentResponse(1, original, { ...indexed, live, cursor });
      assertBounded(response);
      expect(result(response).isError).toBeUndefined();
      const page = data(response);
      expect(page.content.length).toBeGreaterThan(0);
      expect(page.content).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/);
      expect(page.content_scope).toBe(live ? "full_file" : "indexed_representation");
      expect(page.read_mode).toBe(live ? "live" : "indexed");
      if (live) expect(page.sha).toBe(original.sha);
      if (revision) expect(page.revision).toBe(revision);
      revision = page.revision;
      combined += page.content;
      cursor = page.next_cursor;
      expect(page.complete).toBe(cursor === null);
      if (cursor) { expect(cursors.has(cursor)).toBe(false); cursors.add(cursor); }
      expect(++pages).toBeLessThan(50);
    } while (cursor);
    expect(combined).toBe(original.content);
    expect(pages).toBeGreaterThan(1);
  });

  it("marks a complete legacy indexed fragment as a representation, never a full file", async () => {
    const response = await buildPrivateDocumentResponse(1, { ...doc, filename: "note.md::chunk-0", content: "first legacy fragment" }, { ...indexed, cursor: "start" });
    expect(data(response)).toMatchObject({ complete: true, next_cursor: null, read_mode: "indexed", content_scope: "indexed_representation" });
    expect(data(response).instruction).toContain("legacy fragment");
    expect(data(response).instruction).toContain("include_sha:true");
  });

  it("rejects changed snapshots and cannot use a cursor to select another target or user", async () => {
    const original = { ...doc, content: "😀".repeat(30_000) };
    const cursor = data(await buildPrivateDocumentResponse(1, original, { ...indexed, cursor: "start" })).next_cursor;
    const changed = await buildPrivateDocumentResponse(1, { ...original, content: original.content + "changed" }, { ...indexed, cursor });
    expect(data(changed).error).toBe("document_changed");
    for (const [target, read] of [
      [{ ...original, filename: "other.md" }, indexed],
      [{ ...original, source: "other-source" }, indexed],
      [original, { ...indexed, userId: "other-user" }],
      [original, { ...indexed, live: true }],
      [original, { ...indexed, ref: "other-ref" }],
    ] as const) {
      const response = await buildPrivateDocumentResponse(1, target, { ...read, cursor });
      assertBounded(response);
      expect(result(response).isError).toBe(true);
      expect(data(response).error).toBe("invalid_cursor");
    }
    const fields = JSON.parse(Buffer.from(cursor.slice(3), "base64url").toString());
    expect(Object.keys(fields).sort()).toEqual(["binding", "offset", "revision"]);
    expect(JSON.stringify(fields)).not.toContain(indexed.userId);
  });

  it("rejects malformed, unsafe, out-of-range and split-surrogate offsets", async () => {
    const original = { ...doc, content: "😀".repeat(30_000) };
    const cursor = data(await buildPrivateDocumentResponse(1, original, { ...indexed, cursor: "start" })).next_cursor;
    for (const bad of ["", null, 42, "d1.!", "x".repeat(513),
      ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, original.content.length + 1, 1].map(offset => alterCursor(cursor, { offset }))]) {
      const response = await buildPrivateDocumentResponse(1, original, { ...indexed, cursor: bad });
      expect(result(response).isError).toBe(true);
      expect(data(response).error).toBe("invalid_cursor");
    }
  });

  it("does not produce an empty continuation page when metadata consumes the budget", async () => {
    const response = await buildPrivateDocumentResponse(1, { ...doc, filename: "名".repeat(20_000), content: "😀" }, { ...indexed, cursor: "start" });
    assertBounded(response);
    expect(data(response).error).toBe("response_too_large");
    expect(result(response).isError).toBe(true);
  });

  it("keeps an empty document valid and refuses partial headings", async () => {
    const empty = await buildPrivateDocumentResponse(1, { ...doc, content: "" }, { ...indexed, cursor: "start" });
    expect(data(empty)).toMatchObject({ content: "", complete: true, next_cursor: null });
    expect(validateDocumentPageRequest({ cursor: "start", format: "headings" })?.code).toBe("invalid_arguments");
    const outline = await buildPrivateDocumentResponse(1, doc, { ...indexed, headings: [{ title: "x".repeat(40_000) }] });
    expect(result(outline).isError).toBe(true);
    assertBounded(outline);
  });

  it("distinguishes exact lone-surrogate content revisions", async () => {
    const first = { ...doc, content: "x".repeat(40_000) + "\ud800" };
    const cursor = data(await buildPrivateDocumentResponse(1, first, { ...indexed, cursor: "start" })).next_cursor;
    const response = await buildPrivateDocumentResponse(1, { ...first, content: "x".repeat(40_000) + "\ufffd" }, { ...indexed, cursor });
    expect(data(response).error).toBe("document_changed");
    expect(privateResponseBytes(response)).toBeLessThanOrEqual(PRIVATE_READ_RESPONSE_BUDGET_BYTES);
  });
});

describe("validateDocumentPageRequest selector exclusivity (WP-7 \u0424204)", () => {
  it("accepts exactly one selector and rejects any combination of two", () => {
    expect(validateDocumentPageRequest({ cursor: "start" })).toBeNull();
    expect(validateDocumentPageRequest({ tail_lines: 5 })).toBeNull();
    expect(validateDocumentPageRequest({ section: "Title" })).toBeNull();
    for (const combo of [
      { cursor: "start", tail_lines: 5 },
      { cursor: "start", section: "Title" },
      { tail_lines: 5, section: "Title" },
      { cursor: "start", tail_lines: 5, section: "Title" },
    ]) {
      expect(validateDocumentPageRequest(combo)?.code).toBe("invalid_arguments");
    }
  });

  it("rejects a non-positive or non-integer tail_lines", () => {
    for (const tail_lines of [0, -1, 1.5, "3"]) {
      expect(validateDocumentPageRequest({ tail_lines })?.code).toBe("invalid_arguments");
    }
  });

  it("rejects an empty section title", () => {
    expect(validateDocumentPageRequest({ section: "" })?.code).toBe("invalid_arguments");
  });

  it("still requires format:'full' for tail_lines and section, same as cursor", () => {
    expect(validateDocumentPageRequest({ tail_lines: 5, format: "headings" })?.code).toBe("invalid_arguments");
    expect(validateDocumentPageRequest({ section: "Title", format: "headings" })?.code).toBe("invalid_arguments");
  });
});

// WP-7 \u0424204: read just the end or one heading of a growing personal file, instead of paging
// from the start \u2014 the complaint that triggered this phase (a diary rewritten whole on every
// entry just to read its last paragraph).
describe("tail_lines selector", () => {
  it("returns exactly the last N whole lines, byte-for-byte, CRLF included", async () => {
    const content = "a\r\nb\r\nc\r\nd\r\ne";
    const response = await buildPrivateDocumentResponse(1, { ...doc, content }, { ...indexed, tailLines: 2 });
    assertBounded(response);
    expect(data(response)).toMatchObject({ content: "d\r\ne", lines_returned: 2, total_lines: 5, truncated: false, partial_line: false });
  });

  it("does not count a trailing newline as an extra empty line", async () => {
    const content = "a\nb\nc\n";
    const response = await buildPrivateDocumentResponse(1, { ...doc, content }, { ...indexed, tailLines: 2 });
    expect(data(response)).toMatchObject({ content: "b\nc\n", lines_returned: 2, total_lines: 3 });
  });

  it("returns the whole file, not truncated, when it has fewer lines than requested", async () => {
    const content = "only\nthree\nlines";
    const response = await buildPrivateDocumentResponse(1, { ...doc, content }, { ...indexed, tailLines: 50 });
    expect(data(response)).toMatchObject({ content, lines_returned: 3, total_lines: 3, truncated: false });
  });

  it("shrinks to as many trailing lines as the budget allows and marks it truncated", async () => {
    // Each line padded well past 32000/2000 bytes so the full 2000 lines cannot possibly fit.
    const lines = Array.from({ length: 2_000 }, (_, i) => `line-${i}-`.padEnd(100, "x"));
    const content = lines.join("\n");
    const response = await buildPrivateDocumentResponse(1, { ...doc, content }, { ...indexed, tailLines: 2_000 });
    assertBounded(response);
    const page = data(response);
    expect(page.truncated).toBe(true);
    expect(page.partial_line).toBe(false);
    expect(page.lines_returned).toBeGreaterThan(0);
    expect(page.lines_returned).toBeLessThan(2_000);
    expect(content.endsWith(page.content)).toBe(true);
    expect(lines.slice(-page.lines_returned).join("\n")).toBe(page.content);
  });

  it("returns a partial tail of the single last line when even one line cannot fit the budget", async () => {
    const content = "short\n" + "x".repeat(60_000);
    const response = await buildPrivateDocumentResponse(1, { ...doc, content }, { ...indexed, tailLines: 1 });
    assertBounded(response);
    const page = data(response);
    expect(page.partial_line).toBe(true);
    expect(page.truncated).toBe(true);
    expect(page.lines_returned).toBe(1);
    expect(content.endsWith(page.content)).toBe(true);
    expect(page.content.length).toBeGreaterThan(0);
    expect(page.content.length).toBeLessThan(60_000);
  });

  it("refuses rather than returns an empty page when even metadata alone is too large", async () => {
    const response = await buildPrivateDocumentResponse(1, { ...doc, filename: "\u540d".repeat(20_000), content: "x".repeat(60_000) }, { ...indexed, tailLines: 1 });
    assertBounded(response);
    expect(result(response).isError).toBe(true);
    expect(data(response).error).toBe("response_too_large");
  });

  it("works on a live read the same way as indexed", async () => {
    const content = "a\nb\nc";
    const response = await buildPrivateDocumentResponse(1, { ...doc, content, sha: "a".repeat(40) }, { ...indexed, live: true, tailLines: 1 });
    expect(data(response)).toMatchObject({ content: "c", lines_returned: 1, sha: "a".repeat(40) });
  });
});

describe("section selector (bounded pagination window)", () => {
  const sectioned = { ...doc, content: "before\n## Keep\nkept line one\nkept line two\n## Next\nafter" };
  // start/end are resolved by documentHeadings/resolveSection in index.ts; this layer only
  // needs a correct {start, end} window \u2014 covered end-to-end in index.routing.test.ts.
  const section = { start: sectioned.content.indexOf("## Keep"), end: sectioned.content.indexOf("## Next") };

  it("bounds content to the section window, not the whole document", async () => {
    const response = await buildPrivateDocumentResponse(1, sectioned, { ...indexed, section });
    assertBounded(response);
    expect(data(response)).toMatchObject({
      content: sectioned.content.slice(section.start, section.end), complete: true, next_cursor: null,
    });
    expect(data(response).content).not.toContain("before");
    expect(data(response).content).not.toContain("after");
  });

  it("paginates a section larger than the budget without leaking past its end", async () => {
    const big = { ...doc, content: "before\n## Keep\n" + "x".repeat(60_000) + "\n## Next\nafter" };
    const bigSection = { start: big.content.indexOf("## Keep"), end: big.content.indexOf("## Next") };
    let cursor: string | null = "start";
    let combined = "";
    let pages = 0;
    do {
      const response = await buildPrivateDocumentResponse(1, big, { ...indexed, cursor, ...(cursor === "start" ? { section: bigSection } : {}) });
      assertBounded(response);
      const page = data(response);
      combined += page.content;
      cursor = page.next_cursor;
      expect(++pages).toBeLessThan(20);
    } while (cursor);
    expect(combined).toBe(big.content.slice(bigSection.start, bigSection.end));
    expect(combined).not.toContain("after");
    expect(pages).toBeGreaterThan(1);
  });

  it("still rejects a changed document mid-section the same way as a plain cursor", async () => {
    const big = { ...doc, content: "before\n## Keep\n" + "😀".repeat(30_000) + "\n## Next\nafter" };
    const bigSection = { start: big.content.indexOf("## Keep"), end: big.content.indexOf("## Next") };
    const cursor = data(await buildPrivateDocumentResponse(1, big, { ...indexed, cursor: "start", section: bigSection })).next_cursor;
    const changed = await buildPrivateDocumentResponse(1, { ...big, content: big.content + "x" }, { ...indexed, cursor });
    expect(data(changed).error).toBe("document_changed");
  });

  // Codex cold review, round 8: `end` rides inside the cursor unsigned, same as `offset` always
  // has — a caller could widen or drop it on a hand-built continuation and read past the section
  // into the rest of the document. Documented as intentional, not a gap: the same caller is
  // already fully authorized to read that content anyway (cursor:'start' with no section at all
  // gets them the whole file) — see the "NOT a signature or credential" note on `binding` above.
  it("lets a crafted continuation drop the section bound — same trust model as a plain offset", async () => {
    const big = { ...doc, content: "before\n## Keep\n" + "x".repeat(60_000) + "\n## Next\nafter" };
    const bigSection = { start: big.content.indexOf("## Keep"), end: big.content.indexOf("## Next") };
    const cursor = data(await buildPrivateDocumentResponse(1, big, { ...indexed, cursor: "start", section: bigSection })).next_cursor;
    const widened = alterCursor(cursor, { end: big.content.length });
    const response = await buildPrivateDocumentResponse(1, big, { ...indexed, cursor: widened });
    expect(result(response).isError).toBeUndefined();
    expect(data(response).content).toContain("after");
  });
});

describe("document cursor backward compatibility (WP-7 Ф204)", () => {
  function rawCursor(fields: Record<string, unknown>): string {
    return "d1." + Buffer.from(JSON.stringify(fields)).toString("base64url");
  }

  it("still accepts a cursor shaped exactly like one issued before `end` existed", async () => {
    const original = { ...doc, content: "x".repeat(40_000) };
    const first = data(await buildPrivateDocumentResponse(1, original, { ...indexed, cursor: "start" }));
    const fields = JSON.parse(Buffer.from(first.next_cursor.slice(3), "base64url").toString());
    expect(Object.keys(fields).sort()).toEqual(["binding", "offset", "revision"]);
    const page2 = await buildPrivateDocumentResponse(1, original, { ...indexed, cursor: rawCursor(fields) });
    expect(result(page2).isError).toBeUndefined();
  });

  it("rejects a cursor with an unexpected extra key", async () => {
    const original = { ...doc, content: "x".repeat(40_000) };
    const first = data(await buildPrivateDocumentResponse(1, original, { ...indexed, cursor: "start" }));
    const fields = JSON.parse(Buffer.from(first.next_cursor.slice(3), "base64url").toString());
    const response = await buildPrivateDocumentResponse(1, original, { ...indexed, cursor: rawCursor({ ...fields, extra: "x" }) });
    expect(result(response).isError).toBe(true);
    expect(data(response).error).toBe("invalid_cursor");
  });

  it("rejects an `end` smaller than `offset`", async () => {
    const original = { ...doc, content: "x".repeat(40_000) };
    const first = data(await buildPrivateDocumentResponse(1, original, { ...indexed, cursor: "start" }));
    const fields = JSON.parse(Buffer.from(first.next_cursor.slice(3), "base64url").toString());
    const response = await buildPrivateDocumentResponse(1, original, {
      ...indexed, cursor: rawCursor({ ...fields, end: fields.offset - 1 }),
    });
    expect(result(response).isError).toBe(true);
    expect(data(response).error).toBe("invalid_cursor");
  });
});
