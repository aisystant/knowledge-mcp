#!/usr/bin/env bash
# Установка pack-lint pre-commit hook + [R0] placement-линтер + pack-commit-msg
# routing-bypass guard во все Pack-репо.
# see WP-242 Ф5, WP-429 Ф6.2
#
# Восстановлено 2026-07-27 (Mac-сессия) — предыдущая версия ставила в .git/hooks/
# (untracked, per-clone), без core.hooksPath, без [R0], без rhetoric/systems-art/
# agent-rules в PACK_REPOS. Переписано на паттерн DS-my-strategy/scripts/install-hooks.sh
# (WP-436 Ф4): tracked .githooks/, git config core.hooksPath.
#
# Использование: bash scripts/install-pack-hooks.sh [--dry-run]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LINT_SCRIPT="$SCRIPT_DIR/pack-lint.sh"
PLACEMENT_LINTER="$SCRIPT_DIR/f6_placement_linter.py"
IWE_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "🔍 Dry-run режим — изменений не вносится"
fi

PACK_REPOS=(
  "PACK-digital-platform"
  "PACK-personal"
  "PACK-MIM"
  "PACK-autonomous-agents"
  "PACK-ecosystem"
  "PACK-verification"
  "PACK-systems-art"
  "PACK-rhetoric"
  "PACK-agent-rules"
)

INSTALLED=0
SKIPPED=0

for repo in "${PACK_REPOS[@]}"; do
  repo_path="$IWE_DIR/$repo"

  if [ ! -d "$repo_path/.git" ]; then
    echo "  ⏭️  $repo — git репо не найдено, пропускаем"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if $DRY_RUN; then
    echo "  📝 $repo — установить hooks (dry-run)"
    continue
  fi

  hook_dir="$repo_path/.githooks"
  mkdir -p "$hook_dir"

  cat > "$hook_dir/pre-commit" << 'HOOK_EOF'
#!/usr/bin/env bash
# pre-commit hook — pack-lint (WP-242 Ф5) + [R0] placement-линтер (WP-429 Ф6.2)
# tracked hook (.githooks/, паттерн WP-436) — вызывается через core.hooksPath.
# auto-installed by install-pack-hooks.sh — не редактировать вручную, править SoT-скрипты.
set -uo pipefail
IWE="${IWE_ROOT:-$HOME/IWE}"
EXIT_CODE=0

# Маркер стирается безусловно в начале КАЖДОГО прогона — переживает только от
# "своего" pre-commit до "своего" commit-msg в рамках ОДНОЙ попытки коммита.
# Без этого унаследованный маркер от прерванной попытки (editor abort до
# commit-msg) блокирует следующий, никак не связанный коммит требованием тега.
rm -f "$(git rev-parse --git-dir)/ROUTING_BYPASS_USED"

if [ -z "${ALLOW_ROUTING_BYPASS:-}" ]; then
  python3 "$IWE/DS-MCP/knowledge-mcp/scripts/f6_placement_linter.py" || EXIT_CODE=1
else
  touch "$(git rev-parse --git-dir)/ROUTING_BYPASS_USED"
  echo "⚠️  [R0] placement-линтер пропущен: ALLOW_ROUTING_BYPASS=1 (требует тега [routing-bypass] в commit-msg)"
fi

bash "$IWE/DS-MCP/knowledge-mcp/scripts/pack-lint.sh" || EXIT_CODE=1

exit $EXIT_CODE
HOOK_EOF
  chmod +x "$hook_dir/pre-commit"

  cat > "$hook_dir/commit-msg" << 'HOOK_EOF'
#!/usr/bin/env bash
# commit-msg hook — requires [routing-bypass] tag when pre-commit's [R0] was bypassed
# via ALLOW_ROUTING_BYPASS=1 (WP-429 Ф6.2). Marker is unconditionally cleared at the
# top of every run so an aborted commit attempt never leaks its bypass requirement
# onto the next, unrelated commit (HIGH-2 finding, 2026-07-27 independent review).
GIT_DIR="$(git rev-parse --git-dir)"
MARKER="$GIT_DIR/ROUTING_BYPASS_USED"
MSG_FILE="$1"

if [ -f "$MARKER" ]; then
  rm -f "$MARKER"
  if ! grep -qF '[routing-bypass]' "$MSG_FILE" 2>/dev/null; then
    echo ""
    echo "❌ Commit blocked: ALLOW_ROUTING_BYPASS=1 использован, но тег [routing-bypass] отсутствует в сообщении коммита."
    echo "   Добавь тег [routing-bypass] в сообщение коммита, чтобы обход оставлял след."
    exit 1
  fi
fi

exit 0
HOOK_EOF
  chmod +x "$hook_dir/commit-msg"

  git -C "$repo_path" config core.hooksPath .githooks

  echo "  ✅ $repo — hooks установлены (.githooks/, core.hooksPath)"
  INSTALLED=$((INSTALLED + 1))
done

echo ""
echo "Итого: установлено $INSTALLED, пропущено $SKIPPED"
echo "Скрипты: $LINT_SCRIPT, $PLACEMENT_LINTER"
