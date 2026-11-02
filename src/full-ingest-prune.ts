/**
 * Which indexed files of a full-ingest source have left the GitHub tree (WP-596 Ф14).
 *
 * The daily pass (syncFullIngestSource) only adds and rewrites files. Without this step a renamed
 * folder leaves its old rows in the index forever, and search returns the same sections twice
 * (FPF, 2026-10-13: "Engineering DPF Suite/…" next to "DPFs/Engineering DPF Suite/…").
 *
 * Pure so the safety rules are unit-testable without a database.
 */

/** Largest share of the indexed files allowed to disappear in one pass. More than this looks like
 *  a wrong branch, an emptied tree or a path-prefix change, not a cleanup. */
export const PRUNE_MAX_RATIO = 0.2;

export interface PrunePlan {
  toDelete: string[];
  blocked: boolean;
  missingRatio: number;
}

/**
 * @param indexedFiles document paths currently in the index (source_uri before "::")
 * @param treeFiles    EVERY .md path in the GitHub tree, including files over the size prefilter:
 *                     those take the batched path and are not in the "eligible" list, but they exist
 */
export function planPrune(indexedFiles: string[], treeFiles: string[], maxRatio: number = PRUNE_MAX_RATIO): PrunePlan {
  if (indexedFiles.length === 0) return { toDelete: [], blocked: false, missingRatio: 0 };
  const inTree = new Set(treeFiles);
  const missing = indexedFiles.filter((p) => !inTree.has(p));
  const missingRatio = missing.length / indexedFiles.length;
  // An empty tree answered with 200 makes every file "missing"; that is exactly the case the ratio guards.
  if (missingRatio > maxRatio) return { toDelete: [], blocked: true, missingRatio };
  return { toDelete: missing, blocked: false, missingRatio };
}
