#!/usr/bin/env bash
# commit-msg hook — Ф6.2 routing-bypass audit trail (WP-429)
# Если pre-commit (pack-lint.sh [R0]) применил ALLOW_ROUTING_BYPASS=1, оставляет маркер
# .git/ROUTING_BYPASS_USED. Этот хук требует тег [routing-bypass] в сообщении коммита —
# обход маршрутизации не должен быть бесследным. Маркер удаляется при любом исходе:
# следующая попытка commit заново прогонит pre-commit и заново создаст маркер, если
# обход всё ещё применяется.
# see DRR-f6-routing-contract-linter.md (2026-07-24), WP-429 Ф6.2.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
MARKER="$REPO_ROOT/.git/ROUTING_BYPASS_USED"
MSG_FILE="$1"

if [ ! -f "$MARKER" ]; then
  exit 0
fi

rm -f "$MARKER"

if grep -qF '[routing-bypass]' "$MSG_FILE" 2>/dev/null; then
  exit 0
fi

echo ""
echo "🚫 Коммит заблокирован: применён ALLOW_ROUTING_BYPASS=1 (Ф6.2 placement-линтер),"
echo "   но сообщение коммита не содержит тег [routing-bypass]."
echo "   Обход размещения требует явного следа — добавь тег [routing-bypass] в сообщение (WP-429 Ф6.2)."
exit 1
