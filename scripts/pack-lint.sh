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

# --- [R4] Глобальная проверка ID-коллизий (БЛОКИРУЮЩАЯ, до early-exit) ---
# Каждый базовый ID (DP.M.NNN, DP.D.NNN, DP.SC.NNN и т.д.) должен быть уникален в репо.
# Источник: WP-7 Ф-PACK-COLLISIONS (18 мая 2026) — обнаружено 14 коллизий, вызванных
# параллельной разработкой без проверки свободного номера.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
# `|| true` в конце — защита от grep/awk exit 1 при пустом результате с set -e/pipefail
COLLISIONS=$(find "$REPO_ROOT" -name "*.md" -type f 2>/dev/null \
  | grep -v '/\.git/' \
  | grep -v '/archive/' \
  | grep -v '/inbox/' \
  | xargs -n1 basename 2>/dev/null \
  | grep -oE '^[A-Z]+\.[A-Z]+\.[0-9]+' \
  | sort | uniq -c | awk '$1>1{print $2}' || true)

if [ -n "$COLLISIONS" ]; then
  echo ""
  echo "❌ pack-lint [R4]: обнаружены ID-коллизии (два файла с одинаковым базовым ID):"
  echo ""
  echo "$COLLISIONS" | while read coll_id; do
    echo "  [$coll_id]:"
    find "$REPO_ROOT" -name "${coll_id}*.md" -type f 2>/dev/null \
      | grep -v '/\.git/' | grep -v '/archive/' | grep -v '/inbox/' \
      | sed "s|^${REPO_ROOT}/|    |"
  done
  echo ""
  echo "Каждый ID должен быть уникален в репо (ссылки ломаются при дублях)."
  echo "Решение: переименовать один из файлов на следующий свободный ID того же типа,"
  echo "         обновить 'id:' внутри файла + slug-ссылки на него во всём IWE."
  echo ""
  echo "🚫 Коммит заблокирован."
  exit 1
fi

# --- [R5] Загрузка disjointness registry (если есть) ---
DISJOINTNESS_FILE=""
DISJOINT_PAIRS=""
if [ -f "$REPO_ROOT/pack/mim/01-domain-contract/disjointness.md" ]; then
  DISJOINTNESS_FILE="$REPO_ROOT/pack/mim/01-domain-contract/disjointness.md"
elif [ -f "$REPO_ROOT/01-domain-contract/disjointness.md" ]; then
  DISJOINTNESS_FILE="$REPO_ROOT/01-domain-contract/disjointness.md"
fi

if [ -n "$DISJOINTNESS_FILE" ]; then
  DISJOINT_PAIRS=$(awk '/^disjoint_pairs:/{p=1; next} /^[a-zA-Z#]/ && !/^    /{if(p) p=0} p' "$DISJOINTNESS_FILE" | \
    awk '/class_a:/{a=$2} /class_b:/{b=$2; print a "|" b}')
fi

# --- [R6-узкий] Загрузка constraints из 00-pack-manifest.md (если есть) ---
MANIFEST_FILE=""
if [ -f "$REPO_ROOT/pack/mim/00-pack-manifest.md" ]; then
  MANIFEST_FILE="$REPO_ROOT/pack/mim/00-pack-manifest.md"
elif [ -f "$REPO_ROOT/00-pack-manifest.md" ]; then
  MANIFEST_FILE="$REPO_ROOT/00-pack-manifest.md"
fi

VALID_CONSTRAINT_TARGETS="M|WP|D|R|FM|CHR|MAP|SC|SOTA|FMT|PRG|FORM|SOP"

# --- Определить изменённые файлы (для R1-R5) ---
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

  # [R5] disjointness check (only if disjointness.md exists and file has type/types)
  if [ -n "$DISJOINT_PAIRS" ]; then
    file_types_raw=$(get_frontmatter "$rel_file" | awk '
      /^type:/{gsub(/^type:[[:space:]]*/, ""); gsub(/"/, ""); print; next}
      /^types:/{p=1; next}
      p && /^  -/{gsub(/^  -[[:space:]]*/, ""); gsub(/"/, ""); print; next}
      p && /^[^ \t]/{p=0}
    ')
    if [ -n "$file_types_raw" ]; then
      while IFS='|' read -r class_a class_b; do
        [ -z "$class_a" ] || [ -z "$class_b" ] && continue
        has_a=false
        has_b=false
        while IFS= read -r t; do
          [ -z "$t" ] && continue
          if echo "$t" | grep -qxF "$class_a"; then has_a=true; fi
          if echo "$t" | grep -qxF "$class_b"; then has_b=true; fi
        done <<< "$file_types_raw"
        if $has_a && $has_b; then
          file_warns="${file_warns}  [R5] disjointness violation: entity maps to both '$class_a' and '$class_b' (see disjointness.md)\n"
          WARNINGS=$((WARNINGS + 1))
        fi
      done <<< "$DISJOINT_PAIRS"
    fi
  fi

  # Добавить в отчёт если есть предупреждения
  if [ -n "$file_warns" ]; then
    REPORT="${REPORT}📄 ${rel_file}  [${doc_id}]\n${file_warns}\n"
  fi

done <<< "$CHANGED"

# --- [R6-узкий] Validate constraints section in 00-pack-manifest.md ---
if [ -n "$MANIFEST_FILE" ] && echo "$CHANGED" | grep -q "00-pack-manifest.md"; then
  manifest_constraints=$(get_frontmatter "$MANIFEST_FILE" | awk '/^constraints:/{p=1; next} p && /^[^ \t]/{p=0} p')
  if [ -n "$manifest_constraints" ]; then
    # Check each constraint has target and required_fields
    constraint_issues=""
    while IFS= read -r line; do
      if echo "$line" | grep -q "target:"; then
        ct=$(echo "$line" | sed 's/.*target:[[:space:]]*//' | tr -d '"' | tr -d "'")
        if ! echo "$VALID_CONSTRAINT_TARGETS" | grep -q "\b$ct\b"; then
          constraint_issues="${constraint_issues}  Unknown constraint target '$ct' (valid: $VALID_CONSTRAINT_TARGETS)\n"
        fi
      fi
      if echo "$line" | grep -q "required_fields:"; then
        rf=$(echo "$line" | sed 's/.*required_fields:[[:space:]]*//' | tr -d '[]' | tr -d '"')
        if [ -z "$rf" ] || [ "$rf" = "null" ]; then
          constraint_issues="${constraint_issues}  Empty required_fields in constraint\n"
        fi
      fi
    done <<< "$manifest_constraints"
    if [ -n "$constraint_issues" ]; then
      REPORT="${REPORT}📄 $(basename "$MANIFEST_FILE")  [manifest constraints]\n${constraint_issues}\n"
      WARNINGS=$((WARNINGS + 1))
    fi
  fi
fi

# --- Вывод ---
if [ "$WARNINGS" -eq 0 ]; then
  echo "✅ pack-lint: $FILES_CHECKED файлов проверено, нарушений нет (пропущено: $FILES_SKIPPED, R4 коллизий: 0)"
  exit 0
fi

echo ""
echo "⚠️  pack-lint: $FILES_CHECKED файлов проверено, $WARNINGS предупреждений (пропущено: $FILES_SKIPPED, R4 коллизий: 0)"
echo ""
printf "%b" "$REPORT"
echo "ℹ️  Норма: ontology.md (FPF-понятие) + Ф3 двуязычность. Коммит не заблокирован."
echo ""

exit 0
