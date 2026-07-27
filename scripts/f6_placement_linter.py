#!/usr/bin/env python3
"""
Placement linter (WP-429 Ф6.2) — potребитель #2 контракта, гейт pre-commit.

Проверяет staged .md-файлы Pack-репо против routing.yaml: id-паттерн ↔
директория. Вторичная сверка frontmatter type — только там, где контракт
её объявляет (kind без ожидаемого типа не проверяется — legalised mixed).

Срабатывает на РАННЕМ шаге pre-commit (до generate-map.py и его git add),
см. DRR-f6-routing-contract-linter.md. Обход: ALLOW_ROUTING_BYPASS=1
(commit-msg-хук отдельно требует тег [routing-bypass], если обход применён —
эта часть не входит в данный скрипт, реализуется в хуке).

Usage:
  python3 f6_placement_linter.py <pack-root>       # проверить весь Pack (для смоука/CI)
  python3 f6_placement_linter.py --staged <files>  # проверить конкретные пути (pre-commit)
  python3 f6_placement_linter.py --test            # прогон на синтетическом repo
"""

import re
import sys
from dataclasses import dataclass
from pathlib import Path

import yaml


@dataclass
class Violation:
    path: str
    reason: str


def load_contracts(pack_root: Path) -> list[dict]:
    """Один Pack-репо может содержать несколько независимых доменов (напр. PACK-rhetoric:
    pack/language-style/ + pack/rhetoric/), каждый со своим routing.yaml — собираем все.
    Пустой список — ни один домен ещё не мигрирован (WP-429 Ф6.1 остаток), не блокируем."""
    contracts = []
    for contract_path in sorted(pack_root.glob("pack/*/routing.yaml")):
        with open(contract_path, encoding="utf-8") as f:
            contracts.append(yaml.safe_load(f))
    return contracts


def kind_of(filename: str, kinds: dict) -> str | None:
    """Код идентификатора — самый длинный совпадающий префикс kind (SA.D vs SA.D... не путается с SA.ROLE)."""
    matches = [k for k in kinds if filename.startswith(k + ".")]
    if not matches:
        return None
    return max(matches, key=len)


def read_frontmatter_field(path: Path, field: str) -> object | None:
    """Значение произвольного поля YAML frontmatter. Ведущие HTML-комментарии перед --- допустимы."""
    text = path.read_text(encoding="utf-8")
    body = re.sub(r"^(\s*<!--.*?-->\s*)+", "", text, flags=re.DOTALL)
    fm_match = re.match(r"^---\n(.*?)\n---\n", body, re.DOTALL)
    if not fm_match:
        return None
    frontmatter = yaml.safe_load(fm_match.group(1)) or {}
    return frontmatter.get(field)


def find_owning_contract(filename: str, contracts: list[dict]) -> tuple[dict, str] | None:
    """Первый контракт (домен), чей kind распознаёт этот файл. None — вне юрисдикции всех доменов."""
    for contract in contracts:
        kind = kind_of(filename, contract["kinds"])
        if kind is not None:
            return contract, kind
    return None


def check_file(path: Path, pack_root: Path, contracts: list[dict]) -> Violation | None:
    filename = path.name
    owner = find_owning_contract(filename, contracts)
    if owner is None:
        return None  # файл не под юрисдикцией ни одного контракта (не kind-паттерн) — не блокируем
    contract, kind = owner

    spec = contract["kinds"][kind]
    if not re.search(spec["id_pattern"], filename):
        return Violation(str(path), f"имя файла не матчит id_pattern для {kind}: {spec['id_pattern']}")

    expected_dir = (pack_root / spec["dir"]).resolve()
    actual_dir = path.parent.resolve()
    if actual_dir != expected_dir:
        return Violation(str(path), f"{kind} должен лежать в {spec['dir']}, найден в {path.parent}/")

    fm_check = spec.get("frontmatter_check")
    if fm_check is not None:
        field, expected_value = fm_check["field"], fm_check["value"]
        actual_value = read_frontmatter_field(path, field)
        if actual_value != expected_value:
            return Violation(
                str(path),
                f"{kind} требует frontmatter {field}: {expected_value}, найдено: {actual_value!r}",
            )

    return None


def check_paths(paths: list[Path], pack_root: Path) -> list[Violation]:
    contracts = load_contracts(pack_root)
    if not contracts:
        return []  # Pack без routing.yaml — вне юрисдикции контракта, не блокируем

    violations = []
    for path in paths:
        if path.suffix != ".md" or not path.is_file():
            continue  # не-markdown или staged-for-delete (файла больше нет на диске) — не под проверкой
        v = check_file(path, pack_root, contracts)
        if v is not None:
            violations.append(v)
    return violations


def run_test() -> None:
    import shutil
    import tempfile

    tmp = Path(tempfile.mkdtemp(prefix="f6_linter_test_"))
    try:
        pack_root = tmp / "PACK-fixture"
        entities_dir = pack_root / "pack" / "fixture" / "02-domain-entities"
        methods_dir = pack_root / "pack" / "fixture" / "03-methods"
        entities_dir.mkdir(parents=True)
        methods_dir.mkdir(parents=True)

        (pack_root / "pack" / "fixture" / "routing.yaml").write_text(
            "schema_version: 1\n"
            "pack: fixture\n"
            "kinds:\n"
            "  FX.D:\n"
            "    dir: pack/fixture/02-domain-entities/\n"
            r"    id_pattern: 'FX\.D\.\d{3}-[a-z0-9-]+\.md$'" "\n"
            "    frontmatter_check: null\n"
            "  FX.METHOD:\n"
            "    dir: pack/fixture/03-methods/\n"
            r"    id_pattern: 'FX\.METHOD\.\d{3}-[a-z0-9-]+\.md$'" "\n"
            "    frontmatter_check: {field: type, value: method}\n",
            encoding="utf-8",
        )

        # Case 1: корректное размещение, без frontmatter (ожидание null) — должно пройти
        good_entity = entities_dir / "FX.D.001-example.md"
        good_entity.write_text("# FX.D.001\n\nбез frontmatter, это ок для FX.D\n", encoding="utf-8")

        # Case 2: корректное размещение метода с верным type — должно пройти
        good_method = methods_dir / "FX.METHOD.001-example.md"
        good_method.write_text("---\ntype: method\n---\n\n# метод\n", encoding="utf-8")

        # Case 2b: тот же случай, но с ведущими HTML-комментариями перед frontmatter
        # (реальный формат PACK-systems-art/SA.CAT.001 — линтер не должен ловить false positive)
        good_method_with_comment = methods_dir / "FX.METHOD.003-with-comment.md"
        good_method_with_comment.write_text(
            "<!-- index-health: skip -->\n---\ntype: method\n---\n\n# метод с комментарием\n",
            encoding="utf-8",
        )

        # Case 3: неверная директория — должно упасть
        bad_dir = pack_root / "pack" / "fixture" / "FX.D.002-misplaced.md"
        bad_dir.write_text("# misplaced\n", encoding="utf-8")

        # Case 4: неверный frontmatter type — должно упасть
        bad_type = methods_dir / "FX.METHOD.002-wrong-type.md"
        bad_type.write_text("---\ntype: role\n---\n\n# неверный тип\n", encoding="utf-8")

        # Case 5: неверный id_pattern (не 3 цифры) — должно упасть
        bad_id = entities_dir / "FX.D.x-bad-id.md"
        bad_id.write_text("# bad id\n", encoding="utf-8")

        paths = [good_entity, good_method, good_method_with_comment, bad_dir, bad_type, bad_id]
        violations = check_paths(paths, pack_root)
        flagged = {v.path for v in violations}

        assert str(good_entity) not in flagged, "корректный FX.D без frontmatter не должен блокироваться"
        assert str(good_method) not in flagged, "корректный FX.METHOD с верным type не должен блокироваться"
        assert str(good_method_with_comment) not in flagged, "ведущий HTML-комментарий не должен ломать чтение frontmatter"
        assert str(bad_dir) in flagged, "неверное размещение (директория) должно блокироваться"
        assert str(bad_type) in flagged, "неверный frontmatter type должен блокироваться"
        assert str(bad_id) in flagged, "неверный id_pattern должен блокироваться"
        assert len(violations) == 3, f"ожидалось ровно 3 нарушения, получено {len(violations)}: {violations}"

        print(f"f6_placement_linter: {len(violations)}/3 ожидаемых нарушений найдено, 3/3 корректных файла прошли — PASS")

        # Case 6: Pack без routing.yaml (8 из 9 Pack на момент пилота) — не блокируем, вне юрисдикции
        no_contract_root = tmp / "PACK-no-contract"
        (no_contract_root / "pack" / "bare").mkdir(parents=True)
        stray_file = no_contract_root / "pack" / "bare" / "SOMETHING.md"
        stray_file.write_text("# файл в Pack без контракта\n", encoding="utf-8")
        assert check_paths([stray_file], no_contract_root) == [], "Pack без routing.yaml не должен блокировать коммиты"

        # Case 7: staged-путь для git rm (файла больше нет на диске) — не должен падать traceback'ом
        deleted_path = methods_dir / "FX.METHOD.999-deleted.md"
        assert not deleted_path.exists()
        assert check_paths([deleted_path], pack_root) == [], "несуществующий (staged for delete) путь не должен крашить линтер"

        # Case 8: Pack с ДВУМЯ независимыми доменами (реальность PACK-rhetoric: pack/language-style/
        # + pack/rhetoric/, каждый со своим routing.yaml) — второй домен не должен молча выпадать
        multi_root = tmp / "PACK-multi"
        domain_a_dir = multi_root / "pack" / "domain-a" / "02-domain-entities"
        domain_b_dir = multi_root / "pack" / "domain-b" / "02-domain-entities"
        domain_a_dir.mkdir(parents=True)
        domain_b_dir.mkdir(parents=True)
        (multi_root / "pack" / "domain-a" / "routing.yaml").write_text(
            "schema_version: 1\npack: domain-a\nkinds:\n  AA.D:\n"
            "    dir: pack/domain-a/02-domain-entities/\n"
            r"    id_pattern: 'AA\.D\.\d{3}-[a-z0-9-]+\.md$'" "\n    frontmatter_check: null\n",
            encoding="utf-8",
        )
        (multi_root / "pack" / "domain-b" / "routing.yaml").write_text(
            "schema_version: 1\npack: domain-b\nkinds:\n  BB.D:\n"
            "    dir: pack/domain-b/02-domain-entities/\n"
            r"    id_pattern: 'BB\.D\.\d{3}-[a-z0-9-]+\.md$'" "\n    frontmatter_check: null\n",
            encoding="utf-8",
        )
        misplaced_in_b = domain_b_dir / "BB.D.002-misplaced.md"
        # BB.D.002 лежит НЕ в своей директории — сам файл physически в pack/domain-a вместо domain-b:
        wrong_domain_dir = multi_root / "pack" / "domain-a" / "BB.D.003-in-wrong-domain.md"
        wrong_domain_dir.write_text("# должен быть в domain-b, но лежит в domain-a\n", encoding="utf-8")
        misplaced_in_b.write_text("# на месте\n", encoding="utf-8")

        multi_violations = check_paths([misplaced_in_b, wrong_domain_dir], multi_root)
        multi_flagged = {v.path for v in multi_violations}
        assert str(misplaced_in_b) not in multi_flagged, "BB.D.002 на верном месте не должен блокироваться"
        assert str(wrong_domain_dir) in multi_flagged, (
            "BB.D в чужом домене (domain-a вместо domain-b) должен блокироваться — "
            "до фикса find_owning_contract() второй домен молча выпадал из проверки"
        )

        print("f6_placement_linter: доп. регрессии (Pack без контракта, staged-for-delete, multi-domain) — PASS")
    finally:
        shutil.rmtree(tmp)


def main() -> int:
    if "--test" in sys.argv:
        run_test()
        return 0

    if "--staged" in sys.argv:
        idx = sys.argv.index("--staged")
        paths = [Path(p) for p in sys.argv[idx + 1:]]
        pack_root = Path.cwd()
    else:
        if len(sys.argv) < 2:
            print(__doc__)
            return 1
        pack_root = Path(sys.argv[1])
        paths = list(pack_root.glob("pack/*/**/*.md"))

    violations = check_paths(paths, pack_root)
    if not violations:
        print(f"OK: {len(paths)} файл(ов) проверено, нарушений нет.")
        return 0

    for v in violations:
        print(f"BLOCK: {v.path} — {v.reason}", file=sys.stderr)
    print(f"\n{len(violations)} нарушение(й) размещения. Обход: ALLOW_ROUTING_BYPASS=1 (требует тег [routing-bypass] в commit-msg).", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
