/**
 * English concept name in the gateway response (WP-596, request from WP-5 F67).
 *
 * Rules version name-en-publishable/1: the only allowed status is `ok`.
 * A name is publishable only when it is non-empty and has that status.
 * The gateway neither renames the status nor replaces the name, even if the name equals the code.
 * An empty version is forbidden: the snapshot exporter writes no file with an empty version.
 */

export const NAME_EN_PUBLISHABLE_RULES_VERSION = "name-en-publishable/1";
export const NAME_EN_PUBLISHABLE_STATUS = "ok";

export const CONCEPT_NOT_FOUND = { not_found: true } as const;

/**
 * Characters that make a name empty. The same string goes to SQL (btrim in graph_stats),
 * so the count and the per-concept fields cannot disagree on a name made of whitespace.
 * Equals the set String.prototype.trim removes.
 */
export const NAME_EN_BLANK_CHARS =
  "\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680" +
  "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A" +
  "\u2028\u2029\u202F\u205F\u3000\uFEFF";

function isBlank(value: string): boolean {
  for (const ch of value) {
    if (!NAME_EN_BLANK_CHARS.includes(ch)) return false;
  }
  return true;
}

export type NameEnFields = {
  name_en: string | null;
  name_en_status_raw: string | null;
  name_en_publishable: boolean;
  name_en_publishable_rules_version: string;
};

/** A non-empty name has at least one character outside NAME_EN_BLANK_CHARS. */
export function nameEnFields(nameEn: unknown, statusRaw: unknown): NameEnFields {
  const name_en = typeof nameEn === "string" && !isBlank(nameEn) ? nameEn : null;
  const name_en_status_raw = typeof statusRaw === "string" ? statusRaw : null;
  return {
    name_en,
    name_en_status_raw,
    name_en_publishable: name_en !== null && name_en_status_raw === NAME_EN_PUBLISHABLE_STATUS,
    name_en_publishable_rules_version: NAME_EN_PUBLISHABLE_RULES_VERSION,
  };
}

/** Replaces the two database columns with the four contract fields; other row fields stay as they are. */
export function attachNameEnFields<T extends { name_en?: unknown; name_en_status?: unknown }>(
  row: T,
): Omit<T, "name_en" | "name_en_status"> & NameEnFields {
  const { name_en, name_en_status, ...rest } = row;
  return {
    ...rest,
    ...nameEnFields(name_en, name_en_status),
  };
}

/**
 * Share of publishable English names. The denominator is the number of active concepts,
 * the same as the concepts field in graph_stats; zero active concepts gives 0.
 * Six decimal places, so the answer does not drift on a binary fraction.
 */
export function nameEnPublishableShare(count: number, total: number): number {
  if (!Number.isFinite(count) || !Number.isFinite(total) || total <= 0 || count < 0) return 0;
  return Math.round((count / total) * 1_000_000) / 1_000_000;
}

/**
 * Snapshot mark of graph_stats: database clock, UTC, ISO-8601. If the database value does not
 * parse, the worker clock is used: a date parsing failure must not fail the whole statistics call.
 */
export function nameEnAsOf(value: unknown, now: () => Date = () => new Date()): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return now().toISOString();
}
