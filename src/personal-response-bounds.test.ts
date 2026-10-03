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
