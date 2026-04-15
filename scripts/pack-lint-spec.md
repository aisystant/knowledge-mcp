# Pack Lint — Спецификация для Knowledge Linting агента
<!-- see WP-242 Ф5, WP-132 -->

## Назначение

`pack-lint.sh` — pre-commit скрипт, проверяющий Pack-документы на соответствие норме онтологии.
Этот документ — спецификация для реализации Knowledge Linting агента (WP-132).

## Что проверяет

Критерии применяются к каждому `.md` файлу с frontmatter `id:` (Pack-понятия).

| Код | Критерий | Норма-источник |
|-----|----------|----------------|
| R1 | `related:` содержит ≥1 связь с U.* или Pack-ID | ontology.md: колонка «FPF-понятие» |
| R2 | `name_ru` и/или `name_en` — непустые | WP-242 Ф3 двуязычность |
| R3 | `summary` или `definition` — непустое | Базовое требование документируемости |

## Что НЕ проверяет (v1)

- Корректность ссылок (существует ли DP.IWE.001 в БД)
- Семантическое соответствие типа связи (uses vs specializes)
- Валидность значений типа/статуса
- Орфографию name_ru/name_en

Эти проверки — для v2 (WP-132 Knowledge Linting агент).

## Исключения

Файлы НЕ проверяются если:
- Путь содержит: `spec/`, `docs/`, `archive/`, `inbox/`, `.git/`
- Имя файла: `WORKPLAN`, `CHANGELOG`, `README`, `ontology.md`, `CLAUDE`, `CONTRIBUTING`, `STAGING`, `REPO-TYPE`, `MAPSTRATEGIC`
- Имя файла начинается с `_` (тестовые/черновые)
- Нет frontmatter или нет поля `id:`

## Режим работы

**Предупреждение, не блокировка.** Скрипт всегда завершается с `exit 0`.
Коммит не блокируется — это осознанное решение (v1 обкатка).

Блокирующий режим (`exit 1` при наличии предупреждений) — опция для v2 после обкатки.

## Установка

```bash
# Установить во все Pack-репо (IWE)
bash /Users/tserentserenov/IWE/DS-MCP/knowledge-mcp/scripts/install-pack-hooks.sh

# Dry-run (проверить без изменений)
bash /Users/tserentserenov/IWE/DS-MCP/knowledge-mcp/scripts/install-pack-hooks.sh --dry-run
```

Хуки устанавливаются в: PACK-digital-platform, PACK-personal, PACK-MIM, PACK-autonomous-agents,
PACK-ecosystem, PACK-education, PACK-verification.

## Запуск вручную

```bash
cd /path/to/PACK-repo
git add <changed-files>
bash /path/to/pack-lint.sh
```

## Пример вывода (нарушения)

```
⚠️  pack-lint: 1 файлов проверено, 3 предупреждений (пропущено: 1)

📄 pack/digital-platform/02-domain-entities/DP.TEST.999-example.md  [DP.TEST.999]
  [R1] related: отсутствует или пустой (норма: ≥1 связь с U.* или Pack-ID)
  [R2] name_ru и name_en отсутствуют (Ф3 двуязычность)
  [R3] summary/definition отсутствуют

ℹ️  Норма: ontology.md (FPF-понятие) + Ф3 двуязычность. Коммит не заблокирован.
```

## Пример вывода (OK)

```
✅ pack-lint: 1 файлов проверено, нарушений нет (пропущено: 0)
```

## Расширение для WP-132 (Knowledge Linting агент)

Knowledge Linting агент (WP-132) реализует этот скрипт как базу и добавляет:

1. **Ссылочная целостность (R4):** проверить что IDs в `related:` существуют в БД knowledge-mcp
2. **Тип связи (R5):** соответствие `uses` / `specializes` / `part_of` онтологии
3. **Cognitive Budget (R6):** `summary` ≤ N токенов (WP-132 Ф5)
4. **Context isolation:** агент запускается независимо, получает только изменённые файлы

Входные данные для агента: список изменённых файлов + их frontmatter (не весь контент).
Выходные данные: структурированный JSON с нарушениями по каждому файлу.

## История изменений

| Дата | Версия | Изменение |
|------|--------|-----------|
| 2026-04-15 | v1.0 | WP-242 Ф5 — базовые проверки R1/R2/R3, режим предупреждения |
