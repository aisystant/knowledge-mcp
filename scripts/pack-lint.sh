#!/usr/bin/env bash
# see WP-242 Ф5, DP.SC.WP-132
# Pack pre-commit lint — проверяет изменённые .md файлы в Pack-репо на соответствие норме.
# Режим: предупреждение (exit 0), не блокировка.
# Требуется bash >= 3.x (macOS совместимо).
#
# Норма: ontology.md (колонка FPF-понятие) + Ф3 двуязычность (name_ru/name_en).
#
# Критерии (для файлов с frontmatter id:):
#   [R1] related: — хотя бы одна связь (U.* или Pack-ID вида XX.TYPE.NNN)
#   [R2] name_ru или name_en — хотя бы одно из двух (предпочтительно оба)
#   [R3] summary или definition — непустое
#
# Исключения (не проверяются):
#   - файлы без frontmatter id: (не Pack-понятия: README, CHANGELOG, WORKPLAN, ontology)
#   - файлы из папок: spec/, docs/, archive/, inbox/, _* (тестовые)

set -euo pipefail

# --- Определить изменённые файлы ---
if git rev-parse --verify HEAD &>/dev/null; then
  CHANGED=$(git diff --cached --name-only --diff-filter=ACM | grep '\.md$' || true)
else
  CHANGED=$(git diff --cached --name-only | grep '\.md$' || true)
fi

if [ -z "$CHANGED" ]; then
  exit 0
fi

# --- Константы ---
SKIP_PATHS_PATTERN='(spec/|docs/|archive/|inbox/|\.git/|WORKPLAN|CHANGELOG|README|ONTOLOGY|ontology\.md|CLAUDE|CONTRIBUTING|STAGING|params\.yaml|REPO-TYPE|MAPSTRATEGIC|^_)'

WARNINGS=0
FILES_CHECKED=0
FILES_SKIPPED=0
REPORT=""

# --- Вспомогательные функции ---

# Извлечь frontmatter (содержимое между первыми ---)
get_frontmatter() {
  awk '/^---$/{c++; if(c==2) exit} c==1' "$1"
}

has_frontmatter() {
  head -3 "$1" | grep -q '^---$'
}

get_id() {
  get_frontmatter "$1" | awk '/^id:/{gsub(/^id:[[:space:]]*/, ""); gsub(/"/, ""); print; exit}'
}

# Проверить наличие related: с хотя бы одним ID (XX.TYPE.NNN или U.Something)
has_related_ids() {
  get_frontmatter "$1" | awk '
    /^related:/{p=1; next}
    p && /^[^ \t]/{p=0}
    p && /[A-Z][A-Z0-9]*\.[A-Z][A-Z0-9]/{found=1}
    END{exit !found}
  '
}

# Проверить непустое поле в frontmatter
has_nonempty_field() {
  local file="$1"
  local key="$2"
  local val
  val=$(get_frontmatter "$file" | grep "^${key}:" | sed "s/^${key}:[[:space:]]*//" | tr -d '"')
  [ -n "$val" ] && [ "$val" != '""' ]
}

# --- Проверить каждый файл ---
while IFS= read -r rel_file; do
  # Пропустить по пути
  basename_file=$(basename "$rel_file")
  if echo "$rel_file" | grep -qE "$SKIP_PATHS_PATTERN" || echo "$basename_file" | grep -q '^_'; then
    FILES_SKIPPED=$((FILES_SKIPPED + 1))
    continue
  fi

  # Файл должен существовать
  if [ ! -f "$rel_file" ]; then
    FILES_SKIPPED=$((FILES_SKIPPED + 1))
    continue
  fi

  # Нужен frontmatter
  if ! has_frontmatter "$rel_file"; then
    FILES_SKIPPED=$((FILES_SKIPPED + 1))
    continue
  fi

  # Только Pack-понятия (с id:)
  doc_id=$(get_id "$rel_file")
  if [ -z "$doc_id" ]; then
    FILES_SKIPPED=$((FILES_SKIPPED + 1))
    continue
  fi

  FILES_CHECKED=$((FILES_CHECKED + 1))
  file_warns=""

  # [R1] related: с хотя бы одним ID
  if ! has_related_ids "$rel_file"; then
    file_warns="${file_warns}  [R1] related: отсутствует или пустой (норма: ≥1 связь с U.* или Pack-ID)\n"
    WARNINGS=$((WARNINGS + 1))
  fi

  # [R2] name_ru и/или name_en
  has_ru=false
  has_en=false
  has_nonempty_field "$rel_file" "name_ru" && has_ru=true || true
  has_nonempty_field "$rel_file" "name_en" && has_en=true || true

  if ! $has_ru && ! $has_en; then
    file_warns="${file_warns}  [R2] name_ru и name_en отсутствуют (Ф3 двуязычность)\n"
    WARNINGS=$((WARNINGS + 1))
  elif ! $has_ru; then
    file_warns="${file_warns}  [R2] name_ru отсутствует\n"
    WARNINGS=$((WARNINGS + 1))
  elif ! $has_en; then
    file_warns="${file_warns}  [R2] name_en отсутствует\n"
    WARNINGS=$((WARNINGS + 1))
  fi

  # [R3] summary или definition
  has_smry=false
  has_def=false
  has_nonempty_field "$rel_file" "summary" && has_smry=true || true
  has_nonempty_field "$rel_file" "definition" && has_def=true || true

  if ! $has_smry && ! $has_def; then
    file_warns="${file_warns}  [R3] summary/definition отсутствуют\n"
    WARNINGS=$((WARNINGS + 1))
  fi

  # Добавить в отчёт если есть предупреждения
  if [ -n "$file_warns" ]; then
    REPORT="${REPORT}📄 ${rel_file}  [${doc_id}]\n${file_warns}\n"
  fi

done <<< "$CHANGED"

# --- Вывод ---
if [ "$WARNINGS" -eq 0 ]; then
  echo "✅ pack-lint: $FILES_CHECKED файлов проверено, нарушений нет (пропущено: $FILES_SKIPPED)"
  exit 0
fi

echo ""
echo "⚠️  pack-lint: $FILES_CHECKED файлов проверено, $WARNINGS предупреждений (пропущено: $FILES_SKIPPED)"
echo ""
printf "%b" "$REPORT"
echo "ℹ️  Норма: ontology.md (FPF-понятие) + Ф3 двуязычность. Коммит не заблокирован."
echo ""

exit 0
