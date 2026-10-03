export const PRIVATE_READ_RESPONSE_BUDGET_BYTES = 32_000;
const SEARCH_EXCERPT_UNITS = 2_000;
const SEARCH_TRUNCATION_MARKER = "\n\n...[truncated; use get_document to read more]";
const CURSOR_PREFIX = "d1.";
const CURSOR_MAX_LENGTH = 512;

type RequestId = string | number;
type ResponseEnvelope = { jsonrpc: "2.0"; id: RequestId | null; result?: unknown; error?: { code: number; message: string } };
type Problem = { code: string; message: string };
type DocumentCursor = { offset: number; binding: string; revision: string };

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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(",") !== "binding,offset,revision"
    || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0
    || typeof parsed.binding !== "string" || typeof parsed.revision !== "string"
    || !/^[a-f0-9]{64}$/.test(parsed.binding) || !/^[a-f0-9]{64}$/.test(parsed.revision)) {
    throw new Error("Invalid document cursor");
  }
  return parsed as DocumentCursor;
}

function encodeCursor(cursor: DocumentCursor): string {
  return CURSOR_PREFIX + btoa(JSON.stringify(cursor)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function validateDocumentPageRequest(args: Record<string, unknown>): Problem | null {
  if (args.cursor === undefined) return null;
  if (args.format !== undefined && args.format !== "full") {
    return { code: "invalid_arguments", message: "Document pages require format:'full'; headings are returned only as a complete outline." };
  }
  if (args.ref !== undefined && (typeof args.ref !== "string" || args.ref.length === 0)) {
    return { code: "invalid_arguments", message: "ref must be a non-empty git ref" };
  }
  try { decodeCursor(args.cursor); } catch {
    return { code: "invalid_cursor", message: "Invalid document cursor; start again with cursor:'start'." };
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
type DocumentRead = { userId: string; live: boolean; ref?: string; cursor?: unknown; headings?: unknown[] };

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
  const start = cursor?.offset ?? 0;
  if (start > doc.content.length || (cursor && start === doc.content.length)
    || !isTextBoundary(doc.content, start)) {
    return privateReadError(id, "invalid_cursor", "Cursor offset is outside the document or splits a Unicode character.");
  }
  const render = (end: number): ResponseEnvelope => textResponse(id, JSON.stringify({
    filename: doc.filename, source: doc.source,
    ...(read.live ? { sha: doc.sha, ...(read.ref !== undefined ? { ref: read.ref } : {}) } : {}),
    content: doc.content.slice(start, end),
    read_mode: readMode,
    content_scope: read.live ? "full_file" : "indexed_representation",
    instruction: read.live
      ? "Collect all pages before editing; sha belongs to the complete file."
      : "complete covers this indexed representation, which may be a legacy fragment; use include_sha:true for the exact file.",
    revision: `v1:${revision}`,
    complete: end === doc.content.length,
    next_cursor: end === doc.content.length ? null : encodeCursor({ offset: end, binding, revision }),
  }, null, 2));

  const remainder = render(doc.content.length);
  if (privateResponseBytes(remainder) <= PRIVATE_READ_RESPONSE_BUDGET_BYTES) return remainder;
  let low = start + 1;
  let high = doc.content.length - 1;
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

export async function buildPrivateDocumentResponse(id: RequestId, doc: PersonalDocument, read: DocumentRead): Promise<ResponseEnvelope> {
  if (read.cursor !== undefined) {
    if (read.headings !== undefined) return privateReadError(id, "invalid_arguments", "Document pages require format:'full'.");
    return pagedDocumentResponse(id, doc, read);
  }
  const text = read.live
    ? JSON.stringify({ filename: doc.filename, source: doc.source, sha: doc.sha, ...(read.ref ? { ref: read.ref } : {}), content: doc.content }, null, 2)
    : read.headings !== undefined
      ? JSON.stringify({ filename: doc.filename, headings: read.headings }, null, 2)
      : doc.content;
  // Legacy readers must never receive a partial success, especially before write(expected_sha).
  return enforcePrivateReadBudget(textResponse(id, text));
}
