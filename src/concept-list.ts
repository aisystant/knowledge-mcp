/**
 * Paged export of the concept graph for platform services (WP-596 F67).
 *
 * A snapshot of English names needs every visible concept, including ones without edges,
 * which neither search (50 hits, fuzzy) nor edge traversal can enumerate. The tool is
 * service-only: a mass export of all names is not a user-facing capability.
 * The closed-source deny-list is applied in the SQL query, the same condition as every
 * other concept tool, so a page can never contain a hidden concept.
 */

import { attachNameEnFields, nameEnAsOf, type NameEnFields } from "./name-en-publishable.js";

export const CONCEPT_LIST_TOOL = "concept_list";
export const CONCEPT_LIST_DEFAULT_LIMIT = 200;
export const CONCEPT_LIST_MAX_LIMIT = 500;

/** Tools that exist for platform services only: hidden from tools/list and refused for everyone else. */
export const SERVICE_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([CONCEPT_LIST_TOOL]);

export type ConceptListSqlRow = {
  id: number | string;
  code: string | null;
  name: string;
  level: string;
  domain: string | null;
  status: string;
  name_en: string | null;
  name_en_status: string | null;
};

export type ConceptListRow = Omit<ConceptListSqlRow, "name_en" | "name_en_status"> & NameEnFields;

export type ConceptListPage = {
  as_of: string;
  rows: ConceptListRow[];
  /** Pass as after_id to get the next page; null on the last page. */
  next_after_id: number | null;
};

/** Cursor: concepts with id greater than this. Anything but a non-negative integer is an error. */
export function parseAfterId(value: unknown): number | string {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  return "after_id must be a non-negative integer";
}

/** Page size: default 200, at most 500. Anything but a positive integer is an error. */
export function parseLimit(value: unknown): number | string {
  if (value === undefined || value === null) return CONCEPT_LIST_DEFAULT_LIMIT;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) {
    return Math.min(value, CONCEPT_LIST_MAX_LIMIT);
  }
  return "limit must be a positive integer";
}

/**
 * Builds a page from rows fetched with limit + 1: the extra row only says there is a next page.
 * `id` is returned as a number (the driver may give bigint as a string).
 */
export function buildConceptListPage(sqlRows: ConceptListSqlRow[], limit: number, asOf: unknown): ConceptListPage {
  const hasMore = sqlRows.length > limit;
  const pageRows = (hasMore ? sqlRows.slice(0, limit) : sqlRows).map((row) => {
    const withFields = attachNameEnFields(row);
    return { ...withFields, id: Number(row.id) } as ConceptListRow;
  });
  const last = pageRows[pageRows.length - 1];
  return {
    as_of: nameEnAsOf(asOf),
    rows: pageRows,
    next_after_id: hasMore && last ? last.id as number : null,
  };
}
