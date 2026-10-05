export const PRIVATE_READ_RESPONSE_BUDGET_BYTES = 32_000;
const SEARCH_EXCERPT_UNITS = 2_000;
const SEARCH_TRUNCATION_MARKER = "\n\n...[truncated; use get_document to read more]";
const CURSOR_PREFIX = "d1.";
const CURSOR_MAX_LENGTH = 512;

type RequestId = string | number;
type ResponseEnvelope = { jsonrpc: "2.0"; id: RequestId | null; result?: unknown; error?: { code: number; message: string } };
type Problem = { code: string; message: string };
type DocumentCursor = { offset: number; binding: string; revision: string; end?: number };

export function privateResponseBytes(response: ResponseEnvelope): number {
  return new TextEncoder().encode(JSON.stringify(response)).length;
}

function textResponse(id: RequestId, text: string): ResponseEnvelope {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
}

function invalidRequestId(): ResponseEnvelope {
  return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request id exceeds the private response budget" } };
}

export function privateReadIdError(id: RequestId): ResponseEnvelope | null {
  // Leave room for a useful bounded error even if the request id itself is huge.
  return privateResponseBytes({ jsonrpc: "2.0", id }) > PRIVATE_READ_RESPONSE_BUDGET_BYTES - 512
    ? invalidRequestId() : null;
}

export function privateReadError(id: RequestId, code: string, message: string): ResponseEnvelope {
  const response: ResponseEnvelope = {
    jsonrpc: "2.0", id,
    result: { content: [{ type: "text", text: JSON.stringify({ error: code, message }) }], isError: true },
  };
  return privateResponseBytes(response) <= PRIVATE_READ_RESPONSE_BUDGET_BYTES ? response : invalidRequestId();
}

/** Also bounds dependency/authorization errors produced outside the response builders. */
export function enforcePrivateReadBudget(response: ResponseEnvelope): ResponseEnvelope {
  if (privateResponseBytes(response) <= PRIVATE_READ_RESPONSE_BUDGET_BYTES) return response;
  if (response.id === null) return invalidRequestId();
  return privateReadError(response.id, "response_too_large", "Private response exceeds 32000 UTF-8 bytes; narrow the request or use get_document with cursor:'start' and format:'full'.");
}

function isTextBoundary(text: string, offset: number): boolean {
  return !(offset > 0 && offset < text.length
    && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff
    && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff);
}

function boundaryAtOrBefore(text: string, offset: number): number {
  return isTextBoundary(text, offset) ? offset : offset - 1;
}

export function buildPrivateSearchResponse<T extends { content: string }>(
  id: RequestId, results: T[], degradation?: unknown,
): ResponseEnvelope {
  const render = (cap: number): ResponseEnvelope => {
    const hits = results.map(hit => hit.content.length <= cap ? hit : {
      ...hit,
      content: hit.content.slice(0, boundaryAtOrBefore(hit.content, cap)) + SEARCH_TRUNCATION_MARKER,
      content_truncated: true,
    });
    const content = [{ type: "text", text: JSON.stringify(hits, null, 2) }];
    if (degradation) content.push({ type: "text", text: JSON.stringify({
      warning: "Смысловой поиск недоступен; выполнен только поиск по тексту. Пустой результат не доказывает отсутствие документа.",
      diagnostic: degradation,
    }) });
    return { jsonrpc: "2.0", id, result: { content, ...(degradation && results.length === 0 ? { isError: true } : {}) } };
  };

  // Never remove a hit, its routing metadata, or the degradation notice to fit.
  // A bounded sequence avoids assuming monotonic size when truncation markers disappear.
  for (let cap = SEARCH_EXCERPT_UNITS; ; cap = Math.floor(cap / 2)) {
    const response = render(cap);
    if (privateResponseBytes(response) <= PRIVATE_READ_RESPONSE_BUDGET_BYTES) return response;
    if (cap === 0) break;
  }
  return privateReadError(id, "response_too_large", "Search metadata exceeds 32000 UTF-8 bytes. Reduce limit or narrow source; no partial result list was returned.");
}

function decodeCursor(value: unknown): DocumentCursor | null {
  if (value === "start") return null;
  if (typeof value !== "string" || value.length > CURSOR_MAX_LENGTH || !/^d1\.[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid document cursor");
  }
  const parsed = JSON.parse(atob(value.slice(CURSOR_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/")));
  const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed).sort().join(",") : "";
  // "end" is optional: absent means "to the end of the whole document" (plain forward paging,
  // unchanged shape of every cursor issued before the section selector existed, WP-7 Ф204).
  if (keys !== "binding,offset,revision" && keys !== "binding,end,offset,revision") {
    throw new Error("Invalid document cursor");
  }
  if (!Number.isSafeInteger(parsed.offset) || parsed.offset < 0
    || typeof parsed.binding !== "string" || typeof parsed.revision !== "string"
    || !/^[a-f0-9]{64}$/.test(parsed.binding) || !/^[a-f0-9]{64}$/.test(parsed.revision)
    || (parsed.end !== undefined && (!Number.isSafeInteger(parsed.end) || parsed.end < parsed.offset))) {
    throw new Error("Invalid document cursor");
  }
  return parsed as DocumentCursor;
}

function encodeCursor(cursor: DocumentCursor): string {
  return CURSOR_PREFIX + btoa(JSON.stringify(cursor)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function validateDocumentPageRequest(args: Record<string, unknown>): Problem | null {
  const selectors = ["cursor", "tail_lines", "section"].filter(key => args[key] !== undefined);
  if (selectors.length > 1) {
    return { code: "invalid_arguments", message: `Only one of cursor, tail_lines, section may be given at once (got ${selectors.join(", ")}).` };
  }
  if (selectors.length === 0) return null;
  if (args.format !== undefined && args.format !== "full") {
    return { code: "invalid_arguments", message: "Document pages require format:'full'; headings are returned only as a complete outline." };
  }
  if (args.ref !== undefined && (typeof args.ref !== "string" || args.ref.length === 0)) {
    return { code: "invalid_arguments", message: "ref must be a non-empty git ref" };
  }
  if (args.cursor !== undefined) {
    try { decodeCursor(args.cursor); } catch {
      return { code: "invalid_cursor", message: "Invalid document cursor; start again with cursor:'start'." };
    }
  }
  if (args.tail_lines !== undefined && (!Number.isSafeInteger(args.tail_lines) || (args.tail_lines as number) <= 0)) {
    return { code: "invalid_arguments", message: "tail_lines must be a positive integer." };
  }
  if (args.section !== undefined && (typeof args.section !== "string" || args.section.trim().length === 0)) {
    return { code: "invalid_arguments", message: "section must be a non-empty heading title." };
  }
  return null;
}

async function digest(value: unknown): Promise<string> {
  // JSON encoding preserves distinctions between lone surrogates and U+FFFD.
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

type PersonalDocument = { filename: string; source: string; content: string; sha?: string };
type SectionBound = { start: number; end: number };
type DocumentRead = {
  userId: string; live: boolean; ref?: string; cursor?: unknown; headings?: unknown[];
  tailLines?: number; section?: SectionBound;
};

/** Shared document metadata envelope — identical for every read shape (plain, paged, tail). */
function documentEnvelope(doc: PersonalDocument, read: DocumentRead, readMode: "live" | "indexed") {
  return {
    filename: doc.filename, source: doc.source,
    ...(read.live ? { sha: doc.sha, ...(read.ref !== undefined ? { ref: read.ref } : {}) } : {}),
    read_mode: readMode,
    content_scope: read.live ? "full_file" : "indexed_representation",
    instruction: read.live
      ? "Collect all pages before editing; sha belongs to the complete file."
      : "complete covers this indexed representation, which may be a legacy fragment; use include_sha:true for the exact file.",
  };
}

async function pagedDocumentResponse(id: RequestId, doc: PersonalDocument, read: DocumentRead): Promise<ResponseEnvelope> {
  let cursor: DocumentCursor | null;
  try { cursor = decodeCursor(read.cursor); } catch {
    return privateReadError(id, "invalid_cursor", "Invalid document cursor; start again with cursor:'start'.");
  }
  const readMode = read.live ? "live" : "indexed";
  // This reproducible digest binds continuation, but is NOT a signature or credential.
  // The caller must resolve the target from current authorized args before entering here.
  const binding = await digest([read.userId, doc.filename, doc.source, readMode, read.ref ?? null]);
  const revision = await digest([doc.content, doc.sha ?? null]);
  if (cursor && cursor.binding !== binding) {
    return privateReadError(id, "invalid_cursor", "Cursor belongs to a different document, user, source, ref or read mode; start again.");
  }
  if (cursor && cursor.revision !== revision) {
    return privateReadError(id, "document_changed", "Document representation changed between pages; discard collected pages and start again.");
  }
  // A section cursor carries its own upper bound (WP-7 Ф204); a plain forward cursor has none
  // and reads to the end of the whole document, same as before this selector existed.
  const boundEnd = cursor?.end ?? read.section?.end ?? doc.content.length;
  const start = cursor?.offset ?? read.section?.start ?? 0;
  if (start > boundEnd || boundEnd > doc.content.length || (cursor && start === boundEnd)
    || !isTextBoundary(doc.content, start)) {
    return privateReadError(id, "invalid_cursor", "Cursor offset is outside the document or splits a Unicode character.");
  }
  // Hoisted out of render(): both are O(document size) and render() runs once per bisection step.
  const totalLines = countLines(doc.content);
  const totalBytes = new TextEncoder().encode(doc.content).length;
  const render = (end: number): ResponseEnvelope => textResponse(id, JSON.stringify({
    ...documentEnvelope(doc, read, readMode),
    content: doc.content.slice(start, end),
    total_lines: totalLines, total_bytes: totalBytes,
    revision: `v1:${revision}`,
    complete: end === boundEnd,
    next_cursor: end === boundEnd ? null : encodeCursor({ offset: end, binding, revision, ...(boundEnd !== doc.content.length ? { end: boundEnd } : {}) }),
  }, null, 2));

  const remainder = render(boundEnd);
  if (privateResponseBytes(remainder) <= PRIVATE_READ_RESPONSE_BUDGET_BYTES) return remainder;
  let low = start + 1;
  let high = boundEnd - 1;
  let best: ResponseEnvelope | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const end = boundaryAtOrBefore(doc.content, middle);
    const response = render(end);
    if (privateResponseBytes(response) <= PRIVATE_READ_RESPONSE_BUDGET_BYTES) {
      if (end > start) best = response;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best ?? privateReadError(id, "response_too_large", "Document metadata leaves no room for a non-empty page within 32000 UTF-8 bytes.");
}

/** Lines in the CommonMark sense: a trailing newline terminates the last line rather than
 * starting an empty one, matching how editors and `wc -l` count a well-formed text file. */
function countLines(content: string): number {
  if (content.length === 0) return 0;
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  return body.split("\n").length;
}

/** Character offset where the last `n` lines of `content` begin, and how many whole lines
 * that actually is (capped by the lines the document has). Slicing the ORIGINAL string from
 * this offset — never splitting and rejoining — preserves `\r\n` exactly as written. */
function tailLinesStart(content: string, n: number): { start: number; lines: number } {
  if (n <= 0) return { start: content.length, lines: 0 };
  let pos = content.endsWith("\n") ? content.length - 1 : content.length;
  let lines = 0;
  while (lines < n) {
    const newline = content.lastIndexOf("\n", pos - 1);
    if (newline === -1) return { start: 0, lines: lines + 1 };
    pos = newline;
    lines++;
  }
  return { start: pos + 1, lines };
}

async function tailLinesDocumentResponse(id: RequestId, doc: PersonalDocument, read: DocumentRead): Promise<ResponseEnvelope> {
  const readMode = read.live ? "live" : "indexed";
  const revision = await digest([doc.content, doc.sha ?? null]);
  const totalLines = countLines(doc.content);
  const totalBytes = new TextEncoder().encode(doc.content).length;
  const requested = read.tailLines!;

  const render = (start: number, linesReturned: number, partialLine: boolean): ResponseEnvelope => textResponse(id, JSON.stringify({
    ...documentEnvelope(doc, read, readMode),
    content: doc.content.slice(start),
    lines_returned: linesReturned, total_lines: totalLines, total_bytes: totalBytes,
    truncated: linesReturned < Math.min(requested, totalLines) || partialLine,
    partial_line: partialLine,
    revision: `v1:${revision}`,
  }, null, 2));

  // Binary search over "how many whole trailing lines" fit the byte budget — monotonic because
  // fewer lines never slice a larger suffix of the same document (WP-7 Ф204, Codex cold review).
  const ideal = tailLinesStart(doc.content, Math.min(requested, totalLines));
  let bestLines = 0;
  let bestStart = doc.content.length;
  let low = 0, high = ideal.lines;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const { start, lines } = tailLinesStart(doc.content, middle);
    const response = render(start, lines, false);
    if (privateResponseBytes(response) <= PRIVATE_READ_RESPONSE_BUDGET_BYTES) {
      bestLines = lines; bestStart = start;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (bestLines > 0 || doc.content.length === 0) return render(bestStart, bestLines, false);

  // Not even one whole line fits the budget — hand back the tail of that single line instead
  // of an empty, useless page (Codex cold review, High: a silent 0-line response is worse than
  // a partial one here, since the caller asked specifically for the end of the document).
  // Unlike the bisection above, growing `start` here SHRINKS the response (end is pinned at
  // content.length) — the fitting direction is reversed, so moving the found boundary must be
  // too: on a fit we narrow `high` to look for an even smaller (more content) start.
  const oneLine = tailLinesStart(doc.content, 1);
  low = oneLine.start + 1; high = doc.content.length;
  let bestPartialStart = doc.content.length;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const start = boundaryAtOrBefore(doc.content, middle);
    if (privateResponseBytes(render(start, 1, true)) <= PRIVATE_READ_RESPONSE_BUDGET_BYTES) {
      bestPartialStart = start; high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return bestPartialStart < doc.content.length
    ? render(bestPartialStart, 1, true)
    : privateReadError(id, "response_too_large", "Document metadata leaves no room for a non-empty page within 32000 UTF-8 bytes.");
}

export async function buildPrivateDocumentResponse(id: RequestId, doc: PersonalDocument, read: DocumentRead): Promise<ResponseEnvelope> {
  const paged = read.cursor !== undefined || read.tailLines !== undefined || read.section !== undefined;
  if (paged && read.headings !== undefined) {
    return privateReadError(id, "invalid_arguments", "Document pages require format:'full'.");
  }
  if (read.tailLines !== undefined) return tailLinesDocumentResponse(id, doc, read);
  if (read.cursor !== undefined || read.section !== undefined) {
    // A `section` read's first page carries no cursor of its own (Kimi cold review, round 8):
    // normalize it to the same explicit "start" a plain forward read uses here, at the one call
    // site that needs it, rather than teaching decodeCursor a second meaning for `undefined`.
    // `=== undefined`, not `??`: an explicit `null`/other garbage cursor must still fail as
    // invalid below, not get silently replaced by "start" (cold review, round 8 — `??` would
    // have papered over exactly the malformed-cursor cases the tests below exist to catch).
    return pagedDocumentResponse(id, doc, { ...read, cursor: read.cursor === undefined ? "start" : read.cursor });
  }
  const text = read.live
    ? JSON.stringify({ filename: doc.filename, source: doc.source, sha: doc.sha, ...(read.ref ? { ref: read.ref } : {}), content: doc.content }, null, 2)
    : read.headings !== undefined
      ? JSON.stringify({ filename: doc.filename, headings: read.headings }, null, 2)
      : doc.content;
  // Legacy readers must never receive a partial success, especially before write(expected_sha).
  return enforcePrivateReadBudget(textResponse(id, text));
}
