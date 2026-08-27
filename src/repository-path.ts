/** Strict repository path primitives shared by scope checks, GitHub I/O, and DB keys. */

export interface ResolvedSourcePath {
  normalizedPrefix: string;
  relativePath: string;
  fullPath: string;
}

/**
 * Canonicalize a repository-relative path without changing Git-visible characters.
 * Unicode code points and literal backslashes are significant Git filename data; the former
 * are preserved and the latter rejected rather than silently mapped to another object.
 */
export function normalizeRepositoryPath(path: string): string {
  if (!path || path.includes("\0")) {
    throw new Error("Repository path must be a non-empty string without NUL bytes");
  }
  if (path.startsWith("/") || path.includes("\\")) {
    throw new Error("Repository path must be relative and use '/' separators");
  }

  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new Error("Repository path must not escape the repository root");
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    throw new Error("Repository path must resolve to a file");
  }
  return segments.join("/");
}

/** Validate prefix and relative path independently, then join with exactly one slash. */
export function resolveSourcePath(pathPrefix: string, path: string): ResolvedSourcePath {
  const relativePath = normalizeRepositoryPath(path);
  const normalizedPrefix = pathPrefix ? normalizeRepositoryPath(pathPrefix) : "";
  return {
    normalizedPrefix,
    relativePath,
    fullPath: normalizedPrefix ? `${normalizedPrefix}/${relativePath}` : relativePath,
  };
}

/** Encode each GitHub path segment while preserving directory separators. */
export function encodeGitHubContentsPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function githubContentsApiUrl(owner: string, repo: string, path: string): string {
  const encodedPath = encodeGitHubContentsPath(normalizeRepositoryPath(path));
  return `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;
}

/** GitHub branch endpoint; a legal slash in the branch name belongs to one URL segment. */
export function githubBranchApiUrl(owner: string, repo: string, branch: string): string {
  if (!branch) throw new Error("GitHub branch must be non-empty");
  return `https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`;
}

export function githubBlobUrl(owner: string, repo: string, path: string, ref: string = "HEAD"): string {
  const encodedPath = encodeGitHubContentsPath(normalizeRepositoryPath(path));
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${encodeURIComponent(ref)}/${encodedPath}`;
}
