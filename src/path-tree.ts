// Path-tree builder for list_path (WP-5 backlog #31, knowledge_list_path/personal_list_path).
// Split out of index.ts (WP-7 Ф117) so layers/personal.ts can build the same tree shape for
// personalListPath without importing the entrypoint module — index.ts already imports
// layers/personal.ts, and the reverse import would form a cycle (flagged in peer review,
// MC-sessions:2026-09/08/2026-09-08-01-ajratg-personal-list-bug).

export interface PathEntry {
  type: "file" | "dir";
  source: string;
  path: string;
  title: string | null;
  // WP-7 Ф122: size in bytes, undefined for a "dir" entry (a synthetic grouping, not a document
  // with its own content) — omitted from JSON rather than null, so a client checking truthiness
  // doesn't need to special-case 0-byte files.
  size_bytes?: number;
}

// WP-7 Ф122: byte length of already-fetched content, not a fresh read — used by both
// index.ts (public listPath) and layers/personal.ts (personalListPath) to report file size
// without an extra query. TextEncoder is a standard Web API, unlike Buffer (Node-only,
// requires the nodejs_compat flag this Worker doesn't set).
export function utf8ByteLength(content: string): number {
  return new TextEncoder().encode(content).length;
}

// Извлекает заголовок документа из его полного content (H1 - та же конвенция,
// что docTitle в scripts/ingest.ts:chunkLargeFile). Применяется к parent-строке
// (единственная строка на файл с ПОЛНЫМ исходным content). НЕ frontmatter YAML.
export function extractTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : null;
}

// Строит "дерево" из плоского списка документов: пути глубже depth схлопываются в
// синтетические type: "dir" записи (без title — директория не документ). depth считается от
// pathPrefix (или от корня источника, если prefix не задан).
// source входит в дедуп-ключ директорий — без него одноимённые поддиректории
// в разных источниках (например "02-domain-entities" в двух разных Pack)
// молча схлопывались бы в одну запись при вызове без фильтра source (cold review finding).
// depth клэмпится здесь же (не только в вызывающем listPath), чтобы контракт
// самой функции был корректен для любого прямого вызова, включая тесты.
export function buildPathTree(
  docs: { source: string; path: string; title: string | null; size_bytes?: number }[],
  pathPrefix: string,
  depth: number
): PathEntry[] {
  const safeDepth = Math.max(1, depth);
  const dirs = new Map<string, PathEntry>();
  const files: PathEntry[] = [];

  for (const doc of docs) {
    const rel = doc.path.startsWith(pathPrefix) ? doc.path.slice(pathPrefix.length) : doc.path;
    const segments = rel.split("/").filter((s) => s.length > 0);
    if (segments.length <= safeDepth) {
      files.push({ type: "file", source: doc.source, path: doc.path, title: doc.title, size_bytes: doc.size_bytes });
    } else {
      const dirPath = pathPrefix + segments.slice(0, safeDepth).join("/");
      const dedupKey = `${doc.source} ${dirPath}`;
      if (!dirs.has(dedupKey)) {
        dirs.set(dedupKey, { type: "dir", source: doc.source, path: dirPath, title: null });
      }
    }
  }

  return [...dirs.values(), ...files].sort(
    (a, b) => a.source.localeCompare(b.source) || a.path.localeCompare(b.path)
  );
}
