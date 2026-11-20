/**
 * WP-560 Ф22: direct read tools for a person's work products (WP registry and WP card).
 *
 * Why: the bot's agent (iwe-interlocutor) answered "my WPs" from a July slice, because
 * docs/WP-REGISTRY.md (~160 KB) does not fit the 32 KB private response budget, and search
 * returns stale index snapshots of WP cards. These tools read the live file from GitHub and
 * return a compact, parsed view that fits the budget in one call.
 *
 * Format contract: the IWE template governance repository — registry tables with the columns
 * "#", "Название", "Ст" (the same columns create_wp writes), WP cards with a YAML `phases:` map and
 * "### ФN …" phase headings. Parsing is pure (no I/O); the dispatcher resolves the source and reads.
 */
import { parseDocument } from "yaml";
import { PRIVATE_READ_RESPONSE_BUDGET_BYTES } from "../personal-response-bounds.js";

export const REGISTRY_PATH = "docs/WP-REGISTRY.md";

/** Registry status emoji → canonical status word (legend of docs/WP-REGISTRY.md). */
const STATUS_BY_EMOJI: ReadonlyArray<[string, string]> = [
  ["🔄", "in_progress"],
  ["⏳", "pending"],
  ["🚧", "blocked"],
  ["🧪", "testing"],
  ["✅", "done"],
  ["📦", "archived"],
  ["↗", "merged"],
  ["❌", "cancelled"],
];

export const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["in_progress", "pending", "blocked"]);
export const WP_LIST_STATUS_FILTERS = ["active", "all", "in_progress", "pending", "blocked", "testing", "done"] as const;
export type WpListStatusFilter = (typeof WP_LIST_STATUS_FILTERS)[number];

/** Phase statuses that mean "nothing left to do here" — such phases are not shown by wp_card. */
const FINISHED_PHASE_STATUSES: ReadonlySet<string> = new Set([
  "done", "closed", "defer", "deferred", "cancelled", "canceled", "merged", "archived", "dropped", "superseded",
]);

const PROGRESS_CAP = 200;
const TITLE_CAP = 160;
const FIELD_CAP = 600;
/** Excerpt lengths tried in turn until the overview of all open phases fits the budget. */
const EXCERPT_STEPS = [800, 400, 160, 0] as const;
/** Leave room for the JSON-RPC envelope and string escaping around the payload. */
const PAYLOAD_BUDGET_BYTES = PRIVATE_READ_RESPONSE_BUDGET_BYTES - 2_000;

const encoder = new TextEncoder();
const byteLength = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

function cleanCell(cell: string): string {
  return cell.replace(/~~|\*\*/g, "").replace(/\s+/g, " ").trim();
}

function cap(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Longest prefix of `text` whose JSON encoding fits `budget` bytes (binary search on length). */
function prefixWithinBytes(text: string, budget: number): string {
  if (byteLength(text) <= budget) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(text.slice(0, middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

// --- registry ---

export interface RegistryRow {
  wp: number;
  status: string;
  priority: string | null;
  title: string;
  progress?: string | null;
}

function statusFromCell(cell: string): string {
  const found = STATUS_BY_EMOJI.find(([emoji]) => cell.includes(emoji));
  return found ? found[1] : cleanCell(cell).toLowerCase() || "unknown";
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());
}

/**
 * Rows of every registry table whose header has the columns "#", "Название" and "Ст".
 * Other tables (status legend, project summary) are skipped.
 */
export function parseRegistry(markdown: string): RegistryRow[] {
  const lines = markdown.split(/\r?\n/);
  const rows: RegistryRow[] = [];
  let columns: string[] | null = null;
  lines.forEach((line, index) => {
    if (!line.trimStart().startsWith("|")) {
      columns = null;
      return;
    }
    if (/^\s*\|\s*:?-{3,}/.test(line)) {
      const header = index > 0 ? splitRow(lines[index - 1]) : [];
      columns = ["#", "Название", "Ст"].every(name => header.includes(name)) ? header : null;
      return;
    }
    if (!columns) return;
    const header = columns;
    const cells = splitRow(line);
    const cell = (name: string): string => {
      const position = header.indexOf(name);
      return position === -1 ? "" : cells[position] ?? "";
    };
    const wp = Number.parseInt(cleanCell(cell("#")).replace(/^WP-/i, ""), 10);
    if (!Number.isInteger(wp)) return;
    const progress = cleanCell(cell("Прогресс"));
    rows.push({
      wp,
      status: statusFromCell(cell("Ст")),
      priority: cleanCell(cell("P")) || null,
      title: cap(cleanCell(cell("Название")), TITLE_CAP),
      progress: progress && progress !== "—" ? cap(progress, PROGRESS_CAP) : null,
    });
  });
  return rows;
}

export interface WpListOptions {
  status?: WpListStatusFilter;
  priority?: string;
  limit?: number;
}

export interface WpListResult {
  status_filter: WpListStatusFilter;
  priority_filter: string | null;
  total_matching: number;
  returned: number;
  /** true when the progress column was dropped so that every matching row fits. */
  progress_omitted: boolean;
  truncated: boolean;
  rows: RegistryRow[];
}

function rowsWithinBudget(rows: RegistryRow[], budget: number): RegistryRow[] {
  const kept: RegistryRow[] = [];
  let used = 2;
  for (const row of rows) {
    used += byteLength(row) + 1;
    if (used > budget) break;
    kept.push(row);
  }
  return kept;
}

/**
 * Filter rows (registry order kept: newest first) and fit them into the response budget.
 * Completeness of the list wins over the progress column: if all rows do not fit with it,
 * the progress column is dropped before any row is.
 */
export function selectRegistryRows(rows: RegistryRow[], options: WpListOptions = {}): WpListResult {
  const statusFilter = options.status ?? "active";
  const priority = options.priority?.trim().toUpperCase() || null;
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 200), 1), 500);
  const matching = rows.filter(row =>
    (statusFilter === "all" || (statusFilter === "active" ? ACTIVE_STATUSES.has(row.status) : row.status === statusFilter))
    && (!priority || (row.priority ?? "").toUpperCase().split(/[\s,]+/).includes(priority)));
  const wanted = matching.slice(0, limit);
  const budget = PAYLOAD_BUDGET_BYTES - 300;
  let kept = rowsWithinBudget(wanted, budget);
  let progressOmitted = false;
  if (kept.length < wanted.length) {
    kept = rowsWithinBudget(wanted.map(({ progress: _progress, ...row }) => row), budget);
    progressOmitted = true;
  }
  return {
    status_filter: statusFilter,
    priority_filter: priority,
    total_matching: matching.length,
    returned: kept.length,
    progress_omitted: progressOmitted,
    truncated: kept.length < matching.length,
    rows: kept,
  };
}

// --- card ---

/** Accepts 560, "560", "WP-560", "РП-560", "РП560". */
export function normalizeWpNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(?:WP|РП)?[-\s]?(\d{1,6})$/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

/** Accepts "Ф22", "ф22", "22", "Ф3а". */
export function normalizePhase(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = String(value).trim().match(/^(?:Ф|F)?(\d{1,4}[а-яa-z]?)$/iu);
  return match ? `Ф${match[1].toLowerCase()}` : null;
}

/** Card locations in a governance repository: folder form first (WP-434), then legacy flat file. */
export function wpCardPaths(wp: number): string[] {
  return [`inbox/WP-${wp}/WP-${wp}.md`, `inbox/WP-${wp}.md`];
}

const CARD_FIELDS = ["wp", "title", "status", "priority", "budget", "created", "updated", "last_session", "progress", "next", "state_transition", "hypothesis"] as const;

interface Heading { level: number; text: string; start: number }

interface ParsedCard {
  fields: Record<string, unknown>;
  phases: Record<string, string> | null;
  body: string;
  headings: Heading[];
}

function splitFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: {}, body: markdown };
  const document = parseDocument(match[1]);
  const value = document.errors.length === 0 ? document.toJS() : null;
  return {
    frontmatter: value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {},
    body: markdown.slice(match[0].length),
  };
}

/** Markdown headings outside fenced code blocks, with their character offsets in `body`. */
function findHeadings(body: string): Heading[] {
  const found: Heading[] = [];
  let inFence = false;
  let offset = 0;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = inFence ? null : line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match) found.push({ level: match[1].length, text: match[2], start: offset });
    offset += line.length + 1;
  }
  return found;
}

function parseCard(markdown: string): ParsedCard {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const fields: Record<string, unknown> = {};
  for (const name of CARD_FIELDS) {
    const value = frontmatter[name];
    if (value === undefined || value === null || value === "") continue;
    fields[name] = typeof value === "string" ? cap(value, FIELD_CAP) : value;
  }
  const raw = frontmatter.phases;
  const phases = raw && typeof raw === "object" && !Array.isArray(raw)
    ? Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
    : null;
  return { fields, phases, body, headings: findHeadings(body) };
}

function sectionText(card: ParsedCard, index: number): string {
  const heading = card.headings[index];
  const next = card.headings.slice(index + 1).find(candidate => candidate.level <= heading.level);
  return card.body.slice(heading.start, next ? next.start : card.body.length).trimEnd();
}

/** "Ф22", "Ф3а" … at the very start of a heading (after optional bold/marker characters). */
function phaseOfHeading(text: string): string | null {
  const match = text.replace(/^[*_~\s]+/, "").match(/^Ф(\d+[а-яa-z]?)(?![\p{L}\p{N}])/u);
  return match ? `Ф${match[1].toLowerCase()}` : null;
}

function isFinished(card: ParsedCard, phase: string): boolean {
  const status = card.phases?.[phase];
  return status !== undefined && FINISHED_PHASE_STATUSES.has(status.toLowerCase());
}

/** First heading of each phase, in card order (a phase may be mentioned again further down). */
function phaseHeadingIndexes(card: ParsedCard): Map<string, number> {
  const first = new Map<string, number>();
  card.headings.forEach((heading, index) => {
    const phase = phaseOfHeading(heading.text);
    if (phase && !first.has(phase)) first.set(phase, index);
  });
  return first;
}

export interface WpCardPhaseSummary {
  phase: string | null;
  status: string | null;
  heading: string;
  excerpt: string;
  chars: number;
}

export interface WpCardOverview {
  fields: Record<string, unknown>;
  phases: Record<string, string> | null;
  open_phases: string[];
  /** One entry per open phase that has a section; read a full one with wp_card(wp, phase). */
  sections: WpCardPhaseSummary[];
  excerpt_chars: number;
}

/**
 * Overview of a WP card: selected frontmatter fields, the phase map and, for every open phase,
 * its heading with the beginning of its text. Closed phases are skipped — they are history, not
 * current work. Excerpts shrink step by step until the whole overview fits the budget, so the
 * list of open phases is never cut.
 */
export function summarizeCard(markdown: string): WpCardOverview {
  const card = parseCard(markdown);
  const openPhases = card.phases ? Object.keys(card.phases).filter(phase => !isFinished(card, phase)) : [];
  const entries: Array<{ phase: string | null; index: number }> = [...phaseHeadingIndexes(card)]
    .filter(([phase]) => !isFinished(card, phase))
    .map(([phase, index]) => ({ phase, index }));
  // A card without phase sections (template cards often have none) still has its working notes.
  if (entries.length === 0) {
    const remaining = card.headings.findIndex(heading => /^Осталось(?![\p{L}\p{N}])/u.test(heading.text));
    if (remaining !== -1) entries.push({ phase: null, index: remaining });
  }
  const texts = entries.map(entry => ({ ...entry, text: sectionText(card, entry.index) }));
  const build = (excerptChars: number): WpCardOverview => ({
    fields: card.fields,
    phases: card.phases,
    open_phases: openPhases,
    sections: texts.map(({ phase, index, text }) => ({
      phase,
      status: phase ? card.phases?.[phase] ?? null : null,
      heading: card.headings[index].text,
      excerpt: cap(text, excerptChars),
      chars: text.length,
    })),
    excerpt_chars: excerptChars,
  });
  for (const step of EXCERPT_STEPS) {
    const overview = build(step);
    if (byteLength(overview) <= PAYLOAD_BUDGET_BYTES) return overview;
  }
  // Even headings alone do not fit: keep as many phases as fit, the open_phases list stays whole.
  const overview = build(0);
  while (overview.sections.length > 0 && byteLength(overview) > PAYLOAD_BUDGET_BYTES) overview.sections.pop();
  return overview;
}

export interface WpCardPhaseText {
  phase: string;
  status: string | null;
  heading: string;
  content: string;
  /** true when the section was longer than the budget; read the rest with get_document(section=heading, cursor:"start"). */
  truncated: boolean;
}

/** Full text of one phase section, or null when the card has no heading for that phase. */
export function cardPhase(markdown: string, phase: string): WpCardPhaseText | null {
  const card = parseCard(markdown);
  const index = phaseHeadingIndexes(card).get(phase);
  if (index === undefined) return null;
  const full = sectionText(card, index);
  const heading = card.headings[index].text;
  const status = card.phases?.[phase] ?? null;
  const envelope = byteLength({ phase, status, heading, content: "", truncated: true });
  const content = prefixWithinBytes(full, PAYLOAD_BUDGET_BYTES - envelope);
  return { phase, status, heading, content, truncated: content.length < full.length };
}
