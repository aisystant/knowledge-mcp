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

/**
 * Phase statuses that mean "nothing left to do here" — such phases are not shown by wp_card.
 * Matched by the leading word: cards write "completed", "moved-to-wp-498", "done (16.10)".
 */
const FINISHED_PHASE_STATUS = /^(?:done|closed|complete|completed|defer|deferred|cancell?ed|canceled|merged|archived|dropped|superseded|moved|transferred)(?![a-z])/i;

const PROGRESS_CAP = 200;
const TITLE_CAP = 160;
const FIELD_CAP = 600;
/** Excerpt lengths tried in turn until the overview of all open phases fits the budget. */
const EXCERPT_STEPS = [800, 400, 160, 0] as const;
/**
 * Room for the JSON-RPC envelope around the tool text and for the fields the dispatcher adds to
 * these payloads (source, file, wp, next_action with a section heading) — over budget, the
 * private-read guard would replace the whole answer with response_too_large.
 */
const ENVELOPE_RESERVE_BYTES = 1_500;
const RESPONSE_BUDGET_BYTES = PRIVATE_READ_RESPONSE_BUDGET_BYTES - ENVELOPE_RESERVE_BYTES;

const encoder = new TextEncoder();
/**
 * Bytes `value` occupies in the final response. The tool text is JSON.stringify(payload), and the
 * response carries that text as a JSON string again — so quotes, backslashes and newlines are
 * escaped twice. Measuring a single layer undercounts text full of quotes and line breaks.
 */
const responseBytes = (value: unknown): number => encoder.encode(JSON.stringify(JSON.stringify(value))).length - 2;

function cleanCell(cell: string): string {
  return cell.replace(/~~|\*\*/g, "").replace(/\s+/g, " ").trim();
}

function cap(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Longest prefix of `text` whose JSON encoding fits `budget` bytes (binary search on length). */
function prefixWithinBytes(text: string, budget: number): string {
  if (responseBytes(text) <= budget) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (responseBytes(text.slice(0, middle)) <= budget) low = middle;
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
    used += responseBytes(row) + 1;
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
  const budget = RESPONSE_BUDGET_BYTES - 300;
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
  return match ? phaseKey(`Ф${match[1]}`) : null;
}

/** Card locations in a governance repository: folder form first (WP-434), then legacy flat file. */
export function wpCardPaths(wp: number): string[] {
  return [`inbox/WP-${wp}/WP-${wp}.md`, `inbox/WP-${wp}.md`];
}

const CARD_FIELDS = ["wp", "title", "status", "priority", "budget", "created", "updated", "last_session", "progress", "next", "state_transition", "hypothesis"] as const;

interface Heading { level: number; text: string; start: number }

interface PhaseInfo { status: string; title: string | null; note: string | null }

interface ParsedCard {
  fields: Record<string, unknown>;
  /** Phase id → status, in card order; null when the card has no readable phase map. */
  phases: Record<string, string> | null;
  phaseInfo: Map<string, PhaseInfo>;
  body: string;
  headings: Heading[];
  warnings: string[];
}

/** Canonical phase id: "Ф3А" and "ф3а" are the same phase as "Ф3а". */
function phaseKey(raw: string): string {
  return raw.trim().replace(/^[фf]/iu, "Ф").replace(/[A-ZА-ЯЁ]$/u, letter => letter.toLowerCase());
}

const text = (value: unknown): string | null => (value === undefined || value === null || value === "" ? null : String(value));

/**
 * Two shapes live in cards: a map (`Ф1: done`) and a list of objects (`- id: Ф1, status: done,
 * title: …, note: …`; 20 of 46 cards with phases in the pilot's repository).
 */
function readPhases(raw: unknown): Map<string, PhaseInfo> | null {
  if (Array.isArray(raw)) {
    const phases = new Map<string, PhaseInfo>();
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const id = text(entry.id);
      if (!id) continue;
      phases.set(phaseKey(id), { status: text(entry.status) ?? "unknown", title: text(entry.title), note: text(entry.note) });
    }
    return phases.size > 0 ? phases : null;
  }
  if (raw && typeof raw === "object") {
    const phases = new Map<string, PhaseInfo>();
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      const nested = value && typeof value === "object" ? value as Record<string, unknown> : null;
      phases.set(phaseKey(id), nested
        ? { status: text(nested.status) ?? "unknown", title: text(nested.title), note: text(nested.note) }
        : { status: text(value) ?? "unknown", title: null, note: null });
    }
    return phases.size > 0 ? phases : null;
  }
  return null;
}

function splitFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; body: string; warnings: string[] } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: {}, body: markdown, warnings: [] };
  // Hand-edited cards repeat keys (WP-406 has three); the last value wins instead of losing the whole header.
  const document = parseDocument(match[1], { uniqueKeys: false });
  const warnings: string[] = document.errors.map(error => error.code);
  let value: unknown = null;
  try {
    value = document.toJS();
  } catch (error) {
    warnings.push(`frontmatter_unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    frontmatter: value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {},
    body: markdown.slice(match[0].length),
    warnings,
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
  const { frontmatter, body, warnings } = splitFrontmatter(markdown);
  const fields: Record<string, unknown> = {};
  for (const name of CARD_FIELDS) {
    const value = frontmatter[name];
    if (value === undefined || value === null || value === "") continue;
    fields[name] = typeof value === "string" ? cap(value, FIELD_CAP) : value;
  }
  const phaseInfo = readPhases(frontmatter.phases) ?? new Map<string, PhaseInfo>();
  const phases = phaseInfo.size > 0 ? Object.fromEntries([...phaseInfo].map(([id, info]) => [id, info.status])) : null;
  return { fields, phases, phaseInfo, body, headings: findHeadings(body), warnings };
}

function sectionText(card: ParsedCard, index: number): string {
  const heading = card.headings[index];
  const next = card.headings.slice(index + 1).find(candidate => candidate.level <= heading.level);
  return card.body.slice(heading.start, next ? next.start : card.body.length).trimEnd();
}

/** "Ф22", "Ф3а" … at the very start of a heading (after optional bold/marker characters). */
function phaseOfHeading(text: string): string | null {
  const match = text.replace(/^[*_~\s]+/, "").match(/^Ф(\d+[а-яa-z]?)(?![\p{L}\p{N}])/u);
  return match ? phaseKey(`Ф${match[1]}`) : null;
}

function isFinished(card: ParsedCard, phase: string): boolean {
  const status = card.phases?.[phase];
  return status !== undefined && FINISHED_PHASE_STATUS.test(status.trim());
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
  /** true when the card has no readable phase map: every phase heading is shown, status unknown. */
  phases_unknown: boolean;
  /** One entry per open phase; read a full one with wp_card(wp, phase). */
  sections: WpCardPhaseSummary[];
  excerpt_chars: number;
  frontmatter_warnings?: string[];
}

interface PhaseText { phase: string | null; status: string | null; heading: string; text: string }

/**
 * Text of a phase: its section when the card has a heading for it, otherwise what the phase list
 * itself says (list-form cards keep title and note in the frontmatter and have no phase headings).
 */
function phaseText(card: ParsedCard, phase: string, headingIndex: number | undefined): PhaseText | null {
  const info = card.phaseInfo.get(phase);
  const status = info?.status ?? null;
  if (headingIndex !== undefined) {
    return { phase, status, heading: card.headings[headingIndex].text, text: sectionText(card, headingIndex) };
  }
  if (!info || (!info.title && !info.note)) return null;
  return { phase, status, heading: info.title ? `${phase} — ${info.title}` : phase, text: info.note ?? "" };
}

function openPhaseTexts(card: ParsedCard): { texts: PhaseText[]; openPhases: string[]; unknown: boolean } {
  const headingIndexes = phaseHeadingIndexes(card);
  if (card.phases) {
    const openPhases = Object.keys(card.phases).filter(phase => !isFinished(card, phase));
    const texts = openPhases.flatMap(phase => phaseText(card, phase, headingIndexes.get(phase)) ?? []);
    return { texts, openPhases, unknown: false };
  }
  const texts = [...headingIndexes].flatMap(([phase, index]) => phaseText(card, phase, index) ?? []);
  if (texts.length === 0) {
    // A card without phases (template cards often have none) still has its working notes.
    const remaining = card.headings.findIndex(heading => /^Осталось(?![\p{L}\p{N}])/u.test(heading.text));
    if (remaining !== -1) texts.push({ phase: null, status: null, heading: card.headings[remaining].text, text: sectionText(card, remaining) });
  }
  return { texts, openPhases: [], unknown: true };
}

/**
 * Overview of a WP card: selected frontmatter fields, the phase map and, for every open phase,
 * its heading with the beginning of its text. Closed phases are skipped — they are history, not
 * current work. Excerpts shrink step by step until the whole overview fits the budget, so the
 * list of open phases is never cut.
 */
export function summarizeCard(markdown: string): WpCardOverview {
  const card = parseCard(markdown);
  const { texts, openPhases, unknown } = openPhaseTexts(card);
  const build = (excerptChars: number): WpCardOverview => ({
    fields: card.fields,
    phases: card.phases,
    open_phases: openPhases,
    phases_unknown: unknown,
    sections: texts.map(({ phase, status, heading, text }) => ({
      phase, status, heading, excerpt: cap(text, excerptChars), chars: text.length,
    })),
    excerpt_chars: excerptChars,
    ...(card.warnings.length > 0 ? { frontmatter_warnings: card.warnings } : {}),
  });
  for (const step of EXCERPT_STEPS) {
    const overview = build(step);
    if (responseBytes(overview) <= RESPONSE_BUDGET_BYTES) return overview;
  }
  // Even headings alone do not fit: keep as many phases as fit, the open_phases list stays whole.
  const overview = build(0);
  while (overview.sections.length > 0 && responseBytes(overview) > RESPONSE_BUDGET_BYTES) overview.sections.pop();
  return overview;
}

export interface WpCardPhaseText {
  phase: string;
  status: string | null;
  heading: string;
  content: string;
  /** true when the section was longer than the budget; the rest is read with get_document(section=heading, include_sha:true). */
  truncated: boolean;
}

/** Full text of one phase (section or phase-list entry), or null when the card does not have it. */
export function cardPhase(markdown: string, phase: string): WpCardPhaseText | null {
  const card = parseCard(markdown);
  const found = phaseText(card, phase, phaseHeadingIndexes(card).get(phase));
  if (!found) return null;
  const envelope = responseBytes({ phase, status: found.status, heading: found.heading, content: "", truncated: true });
  const content = prefixWithinBytes(found.text, RESPONSE_BUDGET_BYTES - envelope);
  return { phase, status: found.status, heading: found.heading, content, truncated: content.length < found.text.length };
}

// --- day plan ---

export const DAY_PLAN_DIRECTORIES = { current: "current", archive: "archive/day-plans" } as const;
const DAY_PLAN_NAME = /^DayPlan (\d{4}-\d{2}-\d{2})\.md$/;

export interface DayPlanChoice {
  path: string;
  date: string;
  /** The plan was moved to the archive: that day is already closed. */
  day_closed: boolean;
}

/**
 * The day plan to show: the one for `date` if given, otherwise the latest. A plan still in
 * current/ wins over an archived copy of the same date (the day is not closed yet).
 */
export function chooseDayPlan(current: string[], archive: string[], date?: string): DayPlanChoice | null {
  const candidates = [
    ...current.map(name => ({ name, directory: DAY_PLAN_DIRECTORIES.current, day_closed: false })),
    ...archive.map(name => ({ name, directory: DAY_PLAN_DIRECTORIES.archive, day_closed: true })),
  ].flatMap(entry => {
    const match = entry.name.match(DAY_PLAN_NAME);
    return match ? [{ path: `${entry.directory}/${entry.name}`, date: match[1], day_closed: entry.day_closed }] : [];
  }).filter(plan => !date || plan.date === date);
  candidates.sort((left, right) => right.date.localeCompare(left.date) || Number(left.day_closed) - Number(right.day_closed));
  return candidates[0] ?? null;
}

/**
 * A day plan prepared for the answer: HTML comments (service markers) removed, and the list of
 * its section headings, so a cut plan can be read further by section rather than page by page.
 */
export function prepareDayPlan(markdown: string): { text: string; headings: string[] } {
  const text = markdown.replace(/<!--[\s\S]*?-->\n?/g, "");
  const headings = findHeadings(text).filter(heading => heading.level >= 2 && heading.level <= 3).map(heading => heading.text);
  return { text, headings };
}

/** `text` cut to what fits the response next to `envelope` (the rest of the payload). */
export function fitText(text: string, envelope: Record<string, unknown>): { content: string; truncated: boolean } {
  const content = prefixWithinBytes(text, RESPONSE_BUDGET_BYTES - responseBytes({ ...envelope, content: "", truncated: true }));
  return { content, truncated: content.length < text.length };
}
