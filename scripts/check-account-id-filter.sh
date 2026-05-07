#!/usr/bin/env bash
# WP-7 Ф-L2-PRIVACY guard: каждый SELECT/JOIN из knowledge_chunk
# должен содержать account_id фильтр в пределах 15 строк после FROM/JOIN.
# Цель: ловить регрессию (новый запрос без isolation) на pre-commit/CI.

set -euo pipefail

cd "$(dirname "$0")/.."

python3 << 'PY'
import sys, re

with open("src/index.ts") as f:
    lines = f.readlines()

pattern = re.compile(r"(FROM|JOIN)\s+\$\{sql\(knowledgeChunkTable\)\}")
write_pattern = re.compile(r"(INSERT INTO|DELETE FROM|UPDATE)\s+\$\{sql\(knowledgeChunkTable\)\}")

violations = []
for i, line in enumerate(lines):
    if pattern.search(line) and not write_pattern.search(line):
        # ищем account_id в next 15 строках (включая саму)
        window = "".join(lines[i:i+15])
        if "account_id" not in window:
            violations.append(f"src/index.ts:{i+1}: {line.rstrip()}")

if violations:
    print("❌ WP-7 Ф-L2-PRIVACY guard: SELECT/JOIN из knowledge_chunk без account_id фильтра:")
    for v in violations:
        print("  " + v)
    print()
    print("Каждый запрос на чтение должен содержать в пределах 15 строк:")
    print("  AND (account_id IS NULL OR account_id::text = NULLIF(current_setting('app.user_id', true), ''))")
    sys.exit(1)

print("✅ WP-7 Ф-L2-PRIVACY guard: все запросы к knowledge_chunk имеют account_id фильтр")
PY
