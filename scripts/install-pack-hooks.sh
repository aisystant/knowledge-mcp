#!/usr/bin/env bash
# Установка pack-lint (WP-242 Ф5) + Ф6.2 placement-линтер (WP-429) hooks во все Pack-репо.
# Использование: bash scripts/install-pack-hooks.sh [--dry-run]
#
# Tracked .githooks/ + core.hooksPath (паттерн WP-436 Ф4, DS-my-strategy/scripts/install-hooks.sh):
# .git/hooks/ не версионируется — правки там не переживают переустановку/новый клон на другой
# машине. .githooks/ коммитится в репо; core.hooksPath — локальная git-настройка, этот скрипт
# её выставляет при каждом запуске (значит достаточно перезапустить установщик на новом клоне,
# не переносить .git/hooks/ вручную).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IWE_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LINT_SCRIPT_REL="DS-MCP/knowledge-mcp/scripts/pack-lint.sh"
COMMIT_MSG_SCRIPT_REL="DS-MCP/knowledge-mcp/scripts/pack-commit-msg.sh"

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
  # PACK-rhetoric ВКЛЮЧЁН 2026-07-27 (был исключён 2026-07-27 тем же днём ранее): живая проверка
  # показала, что "~40 коллизий" были смесью двух явлений — 75 реальных дублей ID (дедуплицированы,
  # см. inbox/WP-429/WP-429.md) и ~49 ложных срабатываний R4 на легитимных суффиксах (RHE.ILL.041-conv,
  # RHE.ILL.359a, RHE.ILL.183-1..6 — числовые/буквенные/словесные фрагменты одной темы). R4 переписан
  # на чтение id: из настоящего frontmatter (не basename-regex) + опциональный allowlist-файл
  # <repo>/.pack-lint-id-allowlist для намеренных совпадений (LS.GENRE.guide/post, canon/snapshot
  # двуязычная пара). Живой прогон pack-lint.sh на PACK-rhetoric — exit 0.
  "PACK-rhetoric"
)

INSTALLED=0
SKIPPED=0

for repo in "${PACK_REPOS[@]}"; do
  repo_path="$IWE_DIR/$repo"
  hooks_dir="$repo_path/.githooks"
  hook_pre="$hooks_dir/pre-commit"
  hook_msg="$hooks_dir/commit-msg"
  backup_dir="$repo_path/.git/hook-backups"

  if [ ! -d "$repo_path/.git" ]; then
    echo "  ⏭️  $repo — git репо не найдено, пропускаем"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  already_installed=false
  if [ -f "$hook_pre" ] && [ -f "$hook_msg" ] \
     && grep -q "pack-lint" "$hook_pre" 2>/dev/null \
     && grep -q "pack-commit-msg" "$hook_msg" 2>/dev/null \
     && [ "$(git -C "$repo_path" config --get core.hooksPath 2>/dev/null || echo '')" = ".githooks" ]; then
    already_installed=true
  fi

  if $already_installed; then
    echo "  ✅ $repo — уже установлен"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if $DRY_RUN; then
    echo "  📝 $repo — установить hooks (dry-run)"
    continue
  fi

  mkdir -p "$hooks_dir" "$backup_dir"

  if [ -f "$hook_pre" ]; then
    cp "$hook_pre" "$backup_dir/pre-commit.backup.$(date +%s)"
  fi
  if [ -f "$hook_msg" ]; then
    cp "$hook_msg" "$backup_dir/commit-msg.backup.$(date +%s)"
  fi

  cat > "$hook_pre" <<PRECOMMIT
#!/usr/bin/env bash
# pre-commit hook — pack-lint (WP-242 Ф5) + Ф6.2 placement-линтер (WP-429)
# tracked hook (.githooks/, паттерн WP-436) — вызывается через core.hooksPath.
# auto-installed by install-pack-hooks.sh — не редактировать вручную, править SoT-скрипты.
IWE="\${IWE_ROOT:-\$HOME/IWE}"
bash "\$IWE/$LINT_SCRIPT_REL"
PRECOMMIT
  chmod +x "$hook_pre"

  cat > "$hook_msg" <<COMMITMSGHOOK
#!/usr/bin/env bash
# commit-msg hook — Ф6.2 routing-bypass audit trail (WP-429)
# tracked hook (.githooks/, паттерн WP-436) — вызывается через core.hooksPath.
# auto-installed by install-pack-hooks.sh — не редактировать вручную, править SoT-скрипт.
IWE="\${IWE_ROOT:-\$HOME/IWE}"
bash "\$IWE/$COMMIT_MSG_SCRIPT_REL" "\$1"
COMMITMSGHOOK
  chmod +x "$hook_msg"

  git -C "$repo_path" config core.hooksPath .githooks

  echo "  ✅ $repo — hooks установлены (.githooks/pre-commit + commit-msg, core.hooksPath)"
  INSTALLED=$((INSTALLED + 1))
done

echo ""
echo "Итого: установлено $INSTALLED, пропущено $SKIPPED"
echo "Lint: \$IWE_ROOT/$LINT_SCRIPT_REL"
echo "Commit-msg: \$IWE_ROOT/$COMMIT_MSG_SCRIPT_REL"
