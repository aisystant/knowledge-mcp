#!/usr/bin/env python3
"""
WP-439 Ф3 — concept name translation applicator.

Translates Russian concept names to English using:
  1. Glossary lookup (iwe-translation-engine/glossary/glossary-v0.1.csv) — free
  2. Claude Haiku via OpenRouter or Anthropic — for unknown terms (~$2-3 for 2710 orphans)

Modes (mutually exclusive):
  --probe        Print distribution stats for name_en columns (read-only)
  --reclassify   Batch UPDATE: unknown + has_en → source='manual', status='unverified'
  --pilot N      Translate first N orphans from concept_translation_orphans
  --bulk         Translate ALL orphans (~2710 concepts)

Flags:
  --dry-run      Show what would happen, no DB writes
  --yes          Skip cost-confirmation prompt for --bulk

Usage:
  python3 scripts/wp439-apply-translations.py --probe
  python3 scripts/wp439-apply-translations.py --reclassify --dry-run
  python3 scripts/wp439-apply-translations.py --pilot 10
  python3 scripts/wp439-apply-translations.py --bulk --yes

Run --reclassify before --pilot/--bulk to avoid re-translating already-named concepts.
"""

import argparse
import csv
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import psycopg2
import psycopg2.extras

SCRIPT_DIR = Path(__file__).parent
GLOSSARY_PATH = (
    Path.home() / "IWE" / "iwe-translation-engine" / "glossary" / "glossary-v0.1.csv"
)
DEV_VARS_PATH = SCRIPT_DIR.parent / ".dev.vars"


# ---- DB connection ----


def _load_dev_vars() -> Dict[str, str]:
    """Read key=value pairs from .dev.vars (Cloudflare Workers local config)."""
    if not DEV_VARS_PATH.exists():
        return {}
    env: Dict[str, str] = {}
    for line in DEV_VARS_PATH.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^(\w+)\s*=\s*(.+)$", line)
        if m:
            env[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return env


def connect() -> "psycopg2.extensions.connection":
    dev_vars = _load_dev_vars()
    url = (
        os.environ.get("KNOWLEDGE_DATABASE_URL")
        or dev_vars.get("KNOWLEDGE_DATABASE_URL")
        or os.environ.get("DATABASE_URL")
        or dev_vars.get("DATABASE_URL")
        or ""
    )
    if not url:
        sys.exit("ERROR: KNOWLEDGE_DATABASE_URL not found in env or .dev.vars")
    # Remove -pooler for direct connection (mirrors TypeScript scripts pattern)
    url = url.replace("-pooler", "")
    if "sslmode=" not in url:
        url += ("&" if "?" in url else "?") + "sslmode=require"
    return psycopg2.connect(url)


# ---- Glossary ----


def load_glossary() -> Dict[str, str]:
    """Return {term_ru: term_en} from glossary CSV. P9: use csv.DictReader."""
    if not GLOSSARY_PATH.exists():
        print(f"[glossary] WARNING: not found at {GLOSSARY_PATH}", file=sys.stderr)
        return {}
    result: Dict[str, str] = {}
    with open(GLOSSARY_PATH, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            ru = (row.get("term_ru") or "").strip()
            en = (row.get("term_en") or "").strip()
            if ru and en:
                result[ru] = en
    print(f"[glossary] Loaded {len(result)} terms from {GLOSSARY_PATH.name}")
    return result


# ---- LLM client ----


def _make_client() -> Tuple[Any, str]:
    """Return (anthropic_client, model_name). Prefers OpenRouter for lower bulk cost."""
    import anthropic  # lazy import — not needed for --probe/--reclassify

    openrouter_key = os.environ.get("OPENROUTER_API_KEY")
    if openrouter_key:
        print("[api] Using OpenRouter (cheaper for bulk)")
        return (
            anthropic.Anthropic(
                base_url="https://openrouter.ai/api/v1",
                api_key=openrouter_key,
            ),
            "anthropic/claude-haiku-4-5-20251001",
        )

    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    if anthropic_key:
        print("[api] Using Anthropic API")
        return anthropic.Anthropic(api_key=anthropic_key), "claude-haiku-4-5-20251001"

    sys.exit("ERROR: set OPENROUTER_API_KEY or ANTHROPIC_API_KEY before translating")


def _translate_one(
    client: Any,
    model: str,
    name_ru: str,
    kind_label: Optional[str],
    parent_code: Optional[str],
    glossary: Dict[str, str],
) -> str:
    """Translate a single concept name to English via Claude Haiku."""
    glossary_sample = "\n".join(
        f"  {ru} → {en}" for ru, en in list(glossary.items())[:20]
    )
    parent_line = (
        f"Parent concept code: {parent_code}"
        if parent_code
        else "No parent type info"
    )
    prompt = (
        f"Translate this Russian systems-thinking concept name to English.\n\n"
        f"Name: {name_ru}\n"
        f"Kind: {kind_label or 'Concept'}\n"
        f"{parent_line}\n\n"
        f"Reference glossary (use these translations when the term matches):\n"
        f"{glossary_sample}\n\n"
        f"Rules:\n"
        f"- Return ONLY the English name (1-6 words, title case)\n"
        f"- Match glossary style exactly for known terms\n"
        f"- No explanations, no punctuation, no quotes"
    )
    resp = client.messages.create(
        model=model,
        max_tokens=60,
        messages=[{"role": "user", "content": prompt}],
    )
    return resp.content[0].text.strip()


# ---- Modes ----


def probe(conn: "psycopg2.extensions.connection") -> None:
    """Print distribution stats for name_en columns (read-only)."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""
            SELECT name_en_source, name_en_status,
                   (name_en IS NOT NULL) AS has_en, COUNT(*)::int AS n
            FROM concept_graph.concepts
            GROUP BY 1, 2, 3
            ORDER BY 4 DESC
        """)
        print("\n=== 1. Full name_en distribution ===")
        for row in cur.fetchall():
            flag = "has_en" if row["has_en"] else "null_en"
            print(
                f"  source={row['name_en_source'] or 'NULL'} "
                f"status={row['name_en_status'] or 'NULL'} {flag}: {row['n']}"
            )

        cur.execute("""
            SELECT (name_en IS NOT NULL) AS has_en,
                   date_trunc('day', created_at)::date AS day,
                   COUNT(*)::int AS n
            FROM concept_graph.concepts
            WHERE name_en_source = 'unknown'
            GROUP BY 1, 2
            ORDER BY 2 DESC, 1 DESC
        """)
        print("\n=== 2. 'unknown' cohort by (has_en, day) ===")
        for row in cur.fetchall():
            flag = "has_en" if row["has_en"] else "null_en"
            print(f"  {row['day']} {flag}: {row['n']}")

        cur.execute("""
            SELECT
              (SELECT COUNT(*)::int FROM concept_graph.concept_kind_context) AS kc,
              (SELECT COUNT(*)::int FROM concept_graph.concept_translation_orphans) AS orphans
        """)
        sizes = cur.fetchone()
        print("\n=== 3. Ф2 VIEW sizes ===")
        print(f"  concept_kind_context:        {sizes['kc']}")
        print(f"  concept_translation_orphans: {sizes['orphans']}")

        cur.execute("""
            SELECT code, name_ru, name_en, name_en_status, created_at::date AS day
            FROM concept_graph.concepts
            WHERE name_en_source = 'unknown'
            ORDER BY random()
            LIMIT 10
        """)
        print("\n=== 4. Sample 10 'unknown' ===")
        for row in cur.fetchall():
            print(
                f"  {row['code']} | {row['name_ru']} | "
                f"en={row['name_en'] or 'NULL'} | {row['name_en_status']} | {row['day']}"
            )


def reclassify(conn: "psycopg2.extensions.connection", dry_run: bool) -> int:
    """Batch UPDATE: unknown + name_en IS NOT NULL → source='manual', status='unverified'."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT COUNT(*)::int FROM concept_graph.concepts
            WHERE name_en_source = 'unknown' AND name_en IS NOT NULL
        """)
        count: int = cur.fetchone()[0]

    print(f"\n[reclassify] {count} rows: source='unknown' AND name_en IS NOT NULL")
    if count == 0:
        return 0

    if dry_run:
        print("[dry-run] Would UPDATE → source='manual', status='unverified'")
        return count

    with conn.cursor() as cur:
        cur.execute("""
            UPDATE concept_graph.concepts
            SET name_en_source = 'manual',
                name_en_status = 'unverified'
            WHERE name_en_source = 'unknown'
              AND name_en IS NOT NULL
        """)
        affected = cur.rowcount
    conn.commit()
    print(f"[reclassify] Updated {affected} rows → source='manual', status='unverified'")
    return affected


def translate_batch(
    conn: "psycopg2.extensions.connection",
    client: Any,
    model: str,
    glossary: Dict[str, str],
    limit: Optional[int],
    dry_run: bool,
) -> None:
    """Translate concepts from concept_translation_orphans using glossary + Claude."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        q = """
            SELECT
                o.id AS concept_id,
                o.code,
                o.name_ru,
                kc.parent_name_en AS kind_label,
                kc.parent_code
            FROM concept_graph.concept_translation_orphans o
            LEFT JOIN concept_graph.concept_kind_context kc ON kc.child_id = o.id
            ORDER BY o.id
        """
        if limit is not None:
            cur.execute(q + " LIMIT %s", (limit,))
        else:
            cur.execute(q)
        rows = cur.fetchall()

    total = len(rows)
    mode_label = f"pilot={limit}" if limit is not None else "bulk"
    print(f"\n[translate] {total} concepts ({mode_label}, dry_run={dry_run})")
    if total == 0:
        print("[translate] Nothing to process — concept_translation_orphans is empty.")
        return

    ok = errors = 0
    for i, row in enumerate(rows, 1):
        name_ru = row["name_ru"] or row["code"]

        if name_ru in glossary:
            name_en = glossary[name_ru]
            en_source, en_status = "glossary", "verified"
            if dry_run:
                print(f"  [{i}/{total}] {name_ru} → {name_en} (glossary, dry-run)")
                ok += 1
                continue
        else:
            if dry_run:
                print(
                    f"  [{i}/{total}] {name_ru} → [LLM] "
                    f"(kind={row['kind_label'] or '?'}, dry-run)"
                )
                ok += 1
                continue
            try:
                name_en = _translate_one(
                    client,
                    model,
                    name_ru,
                    kind_label=row["kind_label"],
                    parent_code=row.get("parent_code"),
                    glossary=glossary,
                )
            except Exception as exc:
                print(f"  [{i}/{total}] ERROR '{name_ru}': {exc}", file=sys.stderr)
                errors += 1
                continue
            en_source, en_status = "llm", "unverified"
            time.sleep(0.2)  # avoid API rate-limit burst

        try:
            with conn.cursor() as cur:
                cur.execute(
                    """UPDATE concept_graph.concepts
                       SET name_en = %s, name_en_source = %s, name_en_status = %s
                       WHERE id = %s AND name_en IS NULL""",
                    (name_en, en_source, en_status, row["concept_id"]),
                )
            conn.commit()
        except psycopg2.Error as exc:
            print(f"  [{i}/{total}] DB ERROR '{name_ru}': {exc}", file=sys.stderr)
            conn.rollback()
            errors += 1
            continue
        print(f"  [{i}/{total}] {name_ru} → {name_en} ({en_source})")
        ok += 1

    print(f"\n[translate] Done: ok={ok} errors={errors} total={total}")


# ---- Entry point ----


def main() -> None:
    parser = argparse.ArgumentParser(
        description="WP-439 Ф3 — concept translation applicator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--probe", action="store_true", help="Print stats (read-only)")
    mode.add_argument(
        "--reclassify",
        action="store_true",
        help="UPDATE unknown+has_en → manual/unverified",
    )
    mode.add_argument("--pilot", type=int, metavar="N", help="Translate first N orphans")
    mode.add_argument("--bulk", action="store_true", help="Translate ALL orphans")
    parser.add_argument("--dry-run", action="store_true", help="No DB writes")
    parser.add_argument("--yes", action="store_true", help="Skip confirmation for --bulk")
    args = parser.parse_args()

    if args.bulk and not args.yes and not args.dry_run:
        print("--bulk will translate ~2710 concepts (~$2-3 via OpenRouter).")
        if input("Type 'yes' to confirm: ").strip().lower() != "yes":
            sys.exit("Aborted.")

    conn = connect()
    try:
        if args.probe:
            probe(conn)
        elif args.reclassify:
            reclassify(conn, dry_run=args.dry_run)
        elif args.pilot is not None:
            glossary = load_glossary()
            client, model = _make_client()
            translate_batch(conn, client, model, glossary, limit=args.pilot, dry_run=args.dry_run)
        else:  # --bulk
            glossary = load_glossary()
            client, model = _make_client()
            translate_batch(conn, client, model, glossary, limit=None, dry_run=args.dry_run)
    except KeyboardInterrupt:
        print("\nInterrupted.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
