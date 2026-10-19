export const SEARCH_RESULT_LIMIT_MAX = 20;

/** Preserve the public search contract while applying it before private SQL too. */
export function normalizeSearchResultLimit(limit: unknown): number {
  return typeof limit === "number" && Number.isFinite(limit)
    ? Math.min(Math.max(Math.trunc(limit), 1), SEARCH_RESULT_LIMIT_MAX)
    : 5;
}
