#!/usr/bin/env python3
"""WP-429 Ф6.6: routing.yaml path health check.

Original Ф6.6 spec targeted `memory/routing-vocab.md` (per DP.FM.296's
incident: a stale PACK-personal path caused silent defers for 1+ month).
Live-checking that file first (2026-07-27) found it now holds only generic
`<PACK>`/`{{...}}` placeholders on every copy found on this machine — the
Ф6.1 work earlier in this same WP superseded it as the concrete SoT:
per-Pack `routing.yaml` files now carry the real `dir:` values DP.FM.296
worried about going stale. Retargeting Ф6.6 to those, which is the current
artifact whose staleness would actually reproduce DP.FM.296's failure mode
(a `kinds.<KIND>.dir` pointing at a nonexistent directory routes candidates
nowhere, same silent-defer effect the original incident described).

Checks every routing.yaml under ~/IWE/PACK-*/ (or a single file via --check):
  - `kinds.<KIND>.dir` resolves to a real directory relative to the Pack root
  - `kinds.<KIND>.id_pattern` (if present) is valid regex

Usage:
    python3 f6_6_routing_map_health.py --scan          # all routing.yaml under ~/IWE
    python3 f6_6_routing_map_health.py --check <path>  # one file
    python3 f6_6_routing_map_health.py --json
    python3 f6_6_routing_map_health.py --test           # synthetic fixtures

Wiring (2026-07-27, Mac-сессия — read-only блокер tsekh-1 снят):
  1. Week Close backstop (weekly timer): подключён в
     ~/IWE/extensions/week-close.after.md (§WP-429 Ф6.6), тот же паттерн, что
     существующий week-close.after.routing-map-check.md (тот делает
     семантическую сверку DP.KR.001; этот — структурную целостность путей
     routing.yaml, разные проверки, не дубль).
  2. Touch-trigger: подключён в pack-lint.sh (DS-MCP/knowledge-mcp/scripts/)
     рядом с [R0] — правка застейдженного routing.yaml перевалидирует сам
     себя перед коммитом.

Перенесено из DS-my-strategy/inbox/WP-429/ в постоянный дом рядом с
f6_placement_linter.py — тот же класс дефекта (HIGH-1, независимое ревью
2026-07-27), который уже нашли для f6_placement_linter.py: путь внутри
inbox/WP-429/ перестаёт существовать при архивации РП, гейт молча замолкает.
"""

import argparse
import json
import re
import sys
from pathlib import Path

IWE_ROOT = Path.home() / "IWE"


def check_routing_yaml(yaml_path: Path) -> dict:
    """Validate one routing.yaml's kinds.*.dir paths and id_pattern regexes.

    Returns:
        {"file": str, "pack_root": str, "kinds_checked": int,
         "stale_dirs": [...], "bad_patterns": [...], "ok": bool}
    """
    try:
        import yaml
    except ImportError:
        sys.exit("pip install pyyaml")

    with open(yaml_path, encoding="utf-8") as f:
        contract = yaml.safe_load(f)

    # Pack root = repo root containing this routing.yaml, walking up to the
    # PACK-* directory (contract may live at repo root or under pack/<domain>/).
    pack_root = yaml_path.parent
    while pack_root.name and not pack_root.name.startswith("PACK-") and pack_root != pack_root.parent:
        pack_root = pack_root.parent

    kinds = (contract or {}).get("kinds", {})
    stale_dirs = []
    bad_patterns = []

    for kind, spec in kinds.items():
        dir_value = spec.get("dir")
        if dir_value:
            resolved = pack_root / dir_value
            if not resolved.is_dir():
                stale_dirs.append({"kind": kind, "dir": dir_value, "resolved": str(resolved)})

        id_pattern = spec.get("id_pattern")
        if id_pattern:
            try:
                re.compile(id_pattern)
            except re.error as e:
                bad_patterns.append({"kind": kind, "id_pattern": id_pattern, "error": str(e)})

    return {
        "file": str(yaml_path),
        "pack_root": str(pack_root),
        "kinds_checked": len(kinds),
        "stale_dirs": stale_dirs,
        "bad_patterns": bad_patterns,
        "ok": not stale_dirs and not bad_patterns,
    }


def scan_all() -> list[dict]:
    return [check_routing_yaml(p) for p in sorted(IWE_ROOT.glob("PACK-*/**/routing.yaml"))]


def run_self_test() -> bool:
    """Synthetic fixtures: clean contract, stale dir, bad regex."""
    import tempfile

    all_pass = True
    fixtures = {
        "clean": ("kinds:\n  X:\n    dir: rules/\n    id_pattern: 'X\\\\.\\\\d+'\n", True, ["rules"]),
        "stale_dir": ("kinds:\n  X:\n    dir: nonexistent-dir-xyz/\n", False, []),
        "bad_regex": ("kinds:\n  X:\n    dir: rules/\n    id_pattern: '[unclosed'\n", False, ["rules"]),
    }

    for name, (content, expect_ok, subdirs) in fixtures.items():
        with tempfile.TemporaryDirectory(prefix="PACK-fixture-") as tmp:
            pack_root = Path(tmp) / "PACK-fixture-test"
            pack_root.mkdir()
            for sub in subdirs:
                (pack_root / sub).mkdir()
            yaml_path = pack_root / "routing.yaml"
            yaml_path.write_text(content, encoding="utf-8")

            result = check_routing_yaml(yaml_path)
            got_ok = result["ok"]
            status = "PASS" if got_ok == expect_ok else "FAIL"
            if status == "FAIL":
                all_pass = False
            print(f"[{status}] fixture={name} expected_ok={expect_ok} got_ok={got_ok} "
                  f"stale={result['stale_dirs']} bad_patterns={result['bad_patterns']}")

    return all_pass


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--scan", action="store_true", help="check every routing.yaml under ~/IWE/PACK-*/")
    group.add_argument("--check", metavar="PATH", help="check a single routing.yaml")
    group.add_argument("--test", action="store_true", help="run self-test fixtures")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args()

    if args.test:
        sys.exit(0 if run_self_test() else 1)

    if args.check:
        results = [check_routing_yaml(Path(args.check))]
    elif args.scan:
        results = scan_all()
    else:
        parser.print_help()
        sys.exit(1)

    overall_ok = all(r["ok"] for r in results)

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        for r in results:
            print(f"{r['file']}  ({r['kinds_checked']} kinds)")
            if r["ok"]:
                print("  OK")
            else:
                for s in r["stale_dirs"]:
                    print(f"  STALE dir: kind={s['kind']} dir={s['dir']} -> {s['resolved']}")
                for b in r["bad_patterns"]:
                    print(f"  BAD id_pattern: kind={b['kind']} pattern={b['id_pattern']} error={b['error']}")
        print(f"\n{len(results)} routing.yaml checked, {'ALL OK' if overall_ok else 'ISSUES FOUND'}")

    sys.exit(0 if overall_ok else 1)


if __name__ == "__main__":
    main()
