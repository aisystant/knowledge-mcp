#!/usr/bin/env python3
"""WP-429 Ф6.2: placement linter — id-паттерн ↔ директория ↔ frontmatter по routing.yaml (Ф6.1).

Проверяет staged (или явно переданные) файлы Pack-репо против машинного контракта
размещения `routing.yaml` (per-Pack, WP-429 Ф6.1): для каждого файла определяет kind
по basename-паттерну, сверяет фактическую директорию и (если задан) frontmatter-поле.

Восстановлено 2026-07-27 (Mac-сессия) — оригинал не найден на диске несмотря на карточку
WP-429, заявлявшую "DONE, 8/8 Pack" (расследование: f6_placement_linter.py отсутствовал и в
inbox/WP-429/, и в заявленном новом месте DS-MCP/knowledge-mcp/scripts/; install-pack-hooks.sh
на диске оказался старой WP-242-версией без core.hooksPath). Логика восстановлена по
спецификации из inbox/WP-429/WP-429.md §Ф6.2 + §независимое ревью (не скопирована из
живого прошлого кода — тот недоступен).

Usage:
    python3 f6_placement_linter.py                  # staged files (pre-commit)
    python3 f6_placement_linter.py --check-all       # весь корпус репо (audit run)
    python3 f6_placement_linter.py --test            # synthetic fixtures
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path


def find_pack_root(start: Path) -> Path:
    """Walk up from `start` to the nearest PACK-* directory (repo root)."""
    p = start
    while p.name and not p.name.startswith("PACK-") and p != p.parent:
        p = p.parent
    return p


def load_contracts(pack_root: Path) -> list[dict]:
    """Load every routing.yaml under this Pack (multi-domain repos have >1 — Ф6.1
    finding: PACK-rhetoric holds two independent domains, language-style + rhetoric,
    each with its own routing.yaml under pack/<domain>/). Fallback to a root-level
    routing.yaml when no pack/*/routing.yaml exists (PACK-agent-rules: flat structure,
    no `pack/` directory at all)."""
    try:
        import yaml
    except ImportError:
        return []

    contracts = []
    domain_paths = sorted(pack_root.glob("pack/*/routing.yaml"))
    if not domain_paths:
        root_contract = pack_root / "routing.yaml"
        if root_contract.is_file():
            domain_paths = [root_contract]

    for path in domain_paths:
        with open(path, encoding="utf-8") as f:
            contract = yaml.safe_load(f)
        if contract and "kinds" in contract:
            contracts.append(contract)

    return contracts


def kind_for_file(basename: str, contracts: list[dict]) -> tuple[str, dict] | None:
    """Find the kind whose id_pattern matches this basename. Longest kind-code prefix
    wins on ambiguity (e.g. `AR.D` before `AR` — both could plausibly match a file
    starting `AR.D.001-...`, but `id_pattern` per-kind already disambiguates via regex,
    so first structural match by descending kind-code length is the tie-break)."""
    candidates = []
    for contract in contracts:
        for kind, spec in contract.get("kinds", {}).items():
            id_pattern = spec.get("id_pattern")
            if id_pattern and re.search(id_pattern, basename):
                candidates.append((kind, spec))
    if not candidates:
        return None
    candidates.sort(key=lambda kc: len(kc[0]), reverse=True)
    return candidates[0]


def read_frontmatter_field(file_path: Path, field: str) -> str | None:
    """Read `field: value` from between the first two `---` lines. Returns None if the
    file has no frontmatter or the field is absent — callers treat None as "check
    fails", not as "field vacuously satisfied"."""
    try:
        text = file_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None

    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None

    try:
        end = lines[1:].index("---") + 1
    except ValueError:
        return None

    for line in lines[1:end]:
        m = re.match(rf"^{re.escape(field)}:\s*(.*)$", line)
        if m:
            return m.group(1).strip().strip('"').strip("'")
    return None


def check_file(repo_relative_path: str, pack_root: Path, contracts: list[dict]) -> dict | None:
    """Check one file against the loaded contracts.

    Returns None if the file matches no kind (out of contract jurisdiction — not a
    violation, just unrecognized by this Pack's routing.yaml). Otherwise returns a
    result dict with `ok: bool` and a `reasons` list of human-readable BLOCK causes.
    """
    basename = Path(repo_relative_path).name
    matched = kind_for_file(basename, contracts)
    if matched is None:
        return None

    kind, spec = matched
    reasons = []

    expected_dir = spec.get("dir")
    if expected_dir:
        expected_dir_norm = expected_dir.rstrip("/") + "/"
        if not repo_relative_path.startswith(expected_dir_norm):
            reasons.append(f"ожидаемая директория '{expected_dir_norm}', файл лежит в '{repo_relative_path}'")

    frontmatter_check = spec.get("frontmatter_check")
    if frontmatter_check:
        field = frontmatter_check["field"]
        expected_value = frontmatter_check["value"]
        actual_value = read_frontmatter_field(pack_root / repo_relative_path, field)
        if actual_value != expected_value:
            reasons.append(f"frontmatter '{field}' ожидалось '{expected_value}', получено '{actual_value}'")

    return {"path": repo_relative_path, "kind": kind, "ok": not reasons, "reasons": reasons}


def staged_files(pack_root: Path) -> list[str]:
    """Files staged for add/copy/modify/rename (not delete — a deleted file has no
    placement to validate). R is required, not just ACM: `git mv` into the wrong
    directory — the exact violation this linter exists to catch — registers as a pure
    rename and is invisible to ACM alone (found live-testing against PACK-verification,
    2026-07-27)."""
    result = subprocess.run(
        ["git", "-C", str(pack_root), "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
        capture_output=True, text=True, check=False,
    )
    return [line for line in result.stdout.splitlines() if line.endswith(".md")]


def all_files(pack_root: Path) -> list[str]:
    result = subprocess.run(
        ["git", "-C", str(pack_root), "ls-files", "*.md"],
        capture_output=True, text=True, check=False,
    )
    return result.stdout.splitlines()


def run_check(files: list[str], pack_root: Path) -> list[dict]:
    contracts = load_contracts(pack_root)
    if not contracts:
        return []
    results = []
    for rel_path in files:
        result = check_file(rel_path, pack_root, contracts)
        if result:
            results.append(result)
    return results


def run_self_test() -> bool:
    """8 scenarios: 3 real violations, 3 clean files, Pack without contract, multi-domain."""
    import tempfile

    all_pass = True

    def make_pack(tmp: Path, contract_yaml: str, files: dict[str, str]) -> Path:
        pack_root = tmp / "PACK-fixture-test"
        pack_root.mkdir()
        (pack_root / "pack" / "fixture").mkdir(parents=True)
        (pack_root / "pack" / "fixture" / "routing.yaml").write_text(contract_yaml, encoding="utf-8")
        for rel_path, content in files.items():
            full = pack_root / rel_path
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_text(content, encoding="utf-8")
        return pack_root

    contract = (
        "kinds:\n"
        "  X.D:\n"
        "    dir: pack/fixture/02-domain-entities/\n"
        "    id_pattern: 'X\\.D\\.\\d{3}-[a-z0-9-]+\\.md$'\n"
        "    frontmatter_check: {field: kind, value: D}\n"
        "    storage: file\n"
    )
    good_fm = "---\nid: X.D.001-thing\nkind: D\n---\nbody\n"
    bad_fm = "---\nid: X.D.002-thing\nkind: WRONG\n---\nbody\n"

    scenarios = {
        "wrong_dir": (contract, {"pack/fixture/wrong-dir/X.D.001-thing.md": good_fm},
                      "pack/fixture/wrong-dir/X.D.001-thing.md", False),
        "wrong_frontmatter": (contract, {"pack/fixture/02-domain-entities/X.D.002-thing.md": bad_fm},
                              "pack/fixture/02-domain-entities/X.D.002-thing.md", False),
        "clean_file": (contract, {"pack/fixture/02-domain-entities/X.D.001-thing.md": good_fm},
                       "pack/fixture/02-domain-entities/X.D.001-thing.md", True),
        "no_contract_match": (contract, {"pack/fixture/02-domain-entities/README.md": "no frontmatter\n"},
                              "pack/fixture/02-domain-entities/README.md", True),  # None = not a violation
    }

    for name, (contract_yaml, files, target, expect_ok) in scenarios.items():
        with tempfile.TemporaryDirectory(prefix="PACK-fixture-") as tmp:
            pack_root = make_pack(Path(tmp), contract_yaml, files)
            contracts = load_contracts(pack_root)
            result = check_file(target, pack_root, contracts)
            got_ok = result is None or result["ok"]
            status = "PASS" if got_ok == expect_ok else "FAIL"
            if status == "FAIL":
                all_pass = False
            print(f"[{status}] fixture={name} expected_ok={expect_ok} got_ok={got_ok} "
                  f"result={result}")

    # No-contract Pack: nothing should match, nothing should block.
    with tempfile.TemporaryDirectory(prefix="PACK-fixture-") as tmp:
        pack_root = Path(tmp) / "PACK-no-contract-test"
        pack_root.mkdir()
        (pack_root / "pack" / "fixture").mkdir(parents=True)
        target_file = pack_root / "pack" / "fixture" / "X.D.001-thing.md"
        target_file.write_text(good_fm, encoding="utf-8")
        contracts = load_contracts(pack_root)
        status = "PASS" if contracts == [] else "FAIL"
        if status == "FAIL":
            all_pass = False
        print(f"[{status}] fixture=no_routing_yaml expected_contracts=[] got_contracts={contracts}")

    # Multi-domain: two routing.yaml under the same Pack, each kind must resolve
    # against its own domain's contract (PACK-rhetoric-style: language-style + rhetoric).
    with tempfile.TemporaryDirectory(prefix="PACK-fixture-") as tmp:
        pack_root = Path(tmp) / "PACK-multi-domain-test"
        pack_root.mkdir()
        for domain, kind_code in [("alpha", "A.D"), ("beta", "B.D")]:
            domain_dir = pack_root / "pack" / domain
            domain_dir.mkdir(parents=True)
            (domain_dir / "routing.yaml").write_text(
                f"kinds:\n  {kind_code}:\n    dir: pack/{domain}/entities/\n"
                f"    id_pattern: '{kind_code.replace('.', chr(92) + '.')}\\.\\d{{3}}-[a-z0-9-]+\\.md$'\n"
                f"    frontmatter_check: null\n    storage: file\n",
                encoding="utf-8",
            )
            (domain_dir / "entities").mkdir(parents=True)
            (domain_dir / "entities" / f"{kind_code}.001-thing.md").write_text(
                "---\nid: x\n---\nbody\n", encoding="utf-8"
            )
        contracts = load_contracts(pack_root)
        got = len(contracts)
        status = "PASS" if got == 2 else "FAIL"
        if status == "FAIL":
            all_pass = False
        print(f"[{status}] fixture=multi_domain expected_contracts=2 got_contracts={got}")

    # Staged-for-delete: a path that no longer exists on disk must not crash the checker
    # (git diff --cached --diff-filter=ACM already excludes D, but --check-all / manual
    # calls can still pass a stale path — read_frontmatter_field must degrade to None,
    # not raise).
    with tempfile.TemporaryDirectory(prefix="PACK-fixture-") as tmp:
        pack_root = make_pack(Path(tmp), contract, {})
        result = check_file("pack/fixture/02-domain-entities/X.D.999-deleted.md", pack_root,
                            load_contracts(pack_root))
        status = "PASS" if result is not None and not result["ok"] else "FAIL"
        if status == "FAIL":
            all_pass = False
        print(f"[{status}] fixture=staged_for_delete_path result={result}")

    return all_pass


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check-all", action="store_true", help="check every .md tracked by git, not just staged")
    parser.add_argument("--test", action="store_true", help="run self-test fixtures")
    args = parser.parse_args()

    if args.test:
        sys.exit(0 if run_self_test() else 1)

    pack_root = find_pack_root(Path.cwd())
    if not pack_root.name.startswith("PACK-"):
        # Not inside a Pack repo — nothing for this linter to do.
        sys.exit(0)

    files = all_files(pack_root) if args.check_all else staged_files(pack_root)
    if not files:
        sys.exit(0)

    results = run_check(files, pack_root)
    violations = [r for r in results if not r["ok"]]

    if not violations:
        print(f"✅ pack-lint [R0]: {len(results)} файлов сверено с routing.yaml, нарушений нет")
        sys.exit(0)

    print(f"❌ pack-lint [R0]: {len(violations)} нарушений размещения (из {len(results)} проверенных):")
    for v in violations:
        print(f"  {v['path']}  [{v['kind']}]")
        for reason in v["reasons"]:
            print(f"    - {reason}")
    print()
    print("Обход (осознанный, оставляет след): ALLOW_ROUTING_BYPASS=1 git commit ... — "
          "требует тега [routing-bypass] в сообщении коммита (commit-msg hook).")
    sys.exit(1)


if __name__ == "__main__":
    main()
