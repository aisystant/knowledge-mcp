#!/usr/bin/env bash
# Установка pack-lint pre-commit hook во все Pack-репо.
# see WP-242 Ф5
# Использование: bash scripts/install-pack-hooks.sh [--dry-run]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LINT_SCRIPT="$SCRIPT_DIR/pack-lint.sh"
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
  "PACK-education"
  "PACK-verification"
)

INSTALLED=0
SKIPPED=0

for repo in "${PACK_REPOS[@]}"; do
  repo_path="$IWE_DIR/$repo"
  hooks_dir="$repo_path/.git/hooks"
  hook_file="$hooks_dir/pre-commit"

  if [ ! -d "$repo_path/.git" ]; then
    echo "  ⏭️  $repo — git репо не найдено, пропускаем"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Проверить: уже установлен?
  if [ -f "$hook_file" ] && grep -q "pack-lint" "$hook_file" 2>/dev/null; then
    echo "  ✅ $repo — уже установлен"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if $DRY_RUN; then
    echo "  📝 $repo — установить hook (dry-run)"
    continue
  fi

  # Если pre-commit уже есть (другое содержимое) — добавить вызов в конец
  if [ -f "$hook_file" ]; then
    echo "" >> "$hook_file"
    echo "# pack-lint (WP-242)" >> "$hook_file"
    echo 'bash "'"$LINT_SCRIPT"'"' >> "$hook_file"
    echo "  📎 $repo — добавлен вызов pack-lint в существующий pre-commit"
  else
    cat > "$hook_file" << 'HOOK_EOF'
#!/usr/bin/env bash
# pre-commit hook — WP-242 Ф5
HOOK_EOF
    echo 'bash "'"$LINT_SCRIPT"'"' >> "$hook_file"
    chmod +x "$hook_file"
    echo "  ✅ $repo — hook создан"
  fi

  INSTALLED=$((INSTALLED + 1))
done

echo ""
echo "Итого: установлено $INSTALLED, пропущено $SKIPPED"
echo "Скрипт lint: $LINT_SCRIPT"
