#!/usr/bin/env python3
"""WP-242 tail backfill: frontmatter name_ru / name_en for remaining ~300 concepts.

Covers all active concepts (fpf/pack) with missing name_ru or name_en,
excluding already backfilled priority 1 (U.* FPF types) and priority 2 (top-50 pack).

Usage:
  python3 wp242-tail-backfill.py --dry-run       # show what would change
  python3 wp242-tail-backfill.py                 # write changes
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dry-run", action="store_true", help="Print changes without writing")
    p.add_argument(
        "--db-url",
        default=None,
        help="Neon DB URL (reads KNOWLEDGE_DATABASE_URL from env if omitted)",
    )
    p.add_argument(
        "--iwe-root",
        type=Path,
        default=Path.home() / "IWE",
        help="IWE root directory",
    )
    return p.parse_args()


def get_db_url(args: argparse.Namespace) -> str:
    url = args.db_url or os.environ.get("KNOWLEDGE_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("Set KNOWLEDGE_DATABASE_URL env var or pass --db-url")
    return url


def fetch_tail_concepts(db_url: str) -> list[dict]:
    """Fetch concept rows from DB that need backfill, excluding U.* and top-50 pack."""
    import psycopg2

    query = """
WITH edge_counts AS (
    SELECT from_concept_id AS concept_id, COUNT(*) AS edge_count
    FROM concept_graph.concept_edges
    GROUP BY from_concept_id
),
ranked AS (
    SELECT c.id,
           ROW_NUMBER() OVER (
               PARTITION BY c.level
               ORDER BY COALESCE(ec.edge_count, 0) DESC
           ) AS rank
    FROM concept_graph.concepts c
    LEFT JOIN edge_counts ec ON ec.concept_id = c.id
    WHERE c.status = 'active' AND c.level = 'pack' AND c.node_type = 'concept'
)
SELECT DISTINCT
    c.id,
    c.code,
    c.name,
    c.name_ru,
    c.name_en,
    c.source_doc,
    c.source_repo,
    c.level,
    COALESCE(ec.edge_count, 0) AS edge_count
FROM concept_graph.concepts c
LEFT JOIN edge_counts ec ON ec.concept_id = c.id
LEFT JOIN ranked ON ranked.id = c.id
WHERE c.status = 'active'
  AND c.node_type = 'concept'
  AND (c.name_ru IS NULL OR c.name_en IS NULL)
  AND NOT (c.level = 'fpf' AND c.code LIKE 'U.%%')
  AND NOT (c.level = 'pack' AND ranked.rank <= 50)
ORDER BY c.level, c.code
"""
    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            cur.execute(query)
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]
    finally:
        conn.close()


_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---", re.DOTALL)


def patch_file(path: Path, name_ru: str | None, name_en: str | None, dry_run: bool) -> bool:
    """Add name_ru / name_en to file frontmatter. Returns True if changed."""
    text = path.read_text(encoding="utf-8")
    fm_match = _FRONTMATTER_RE.match(text)
    if not fm_match:
        print(f"  SKIP (no frontmatter): {path}")
        return False

    fm_body = fm_match.group(1)
    changed = False

    if name_ru and "name_ru:" not in fm_body:
        fm_body += f'\nname_ru: "{name_ru}"'
        changed = True
    if name_en and "name_en:" not in fm_body:
        fm_body += f'\nname_en: "{name_en}"'
        changed = True

    if not changed:
        return False

    new_text = f"---\n{fm_body}\n---" + text[fm_match.end():]
    if dry_run:
        print(f"  [dry-run] would patch: {path}")
    else:
        path.write_text(new_text, encoding="utf-8")
        print(f"  patched: {path}")
    return True


def find_pack_file(iwe_root: Path, source_doc: str | None, source_repo: str | None) -> Path | None:
    """Resolve source_doc relative to source_repo directory under iwe_root."""
    if not source_doc or not source_repo:
        return None
    candidate = iwe_root / source_repo / source_doc
    if candidate.exists():
        return candidate
    hits = list((iwe_root / source_repo).rglob(Path(source_doc).name))
    return hits[0] if hits else None


def main() -> None:
    args = parse_args()
    db_url = get_db_url(args)

    print("Fetching tail concepts from DB (excluding U.* and top-50 pack) ...")
    concepts = fetch_tail_concepts(db_url)
    print(f"Found {len(concepts)} concept(s) needing backfill.")

    patched = 0
    skipped_no_file = 0
    skipped_no_frontmatter = 0

    for row in concepts:
        path = find_pack_file(args.iwe_root, row.get("source_doc"), row.get("source_repo"))
        if path is None:
            print(f"  NO FILE: {row['code']} source_doc={row.get('source_doc')} repo={row.get('source_repo')}")
            skipped_no_file += 1
            continue

        did_patch = patch_file(path, row.get("name_ru"), row.get("name_en"), args.dry_run)
        if did_patch:
            patched += 1
        else:
            skipped_no_frontmatter += 1

    suffix = " (dry-run)" if args.dry_run else ""
    print(
        f"\nDone{suffix}: patched={patched}, no-file={skipped_no_file}, "
        f"already-complete={skipped_no_frontmatter}, total={len(concepts)}"
    )

    if not args.dry_run and patched > 0:
        print("\nNext: run 'knowledge_reindex_source' for affected repos to sync DB.")


if __name__ == "__main__":
    main()
