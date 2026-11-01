# Набор приёмки полей шлюза (РП-5 Ф67 → РП-596)

Снятие: 2026-11-01, один читающий запрос к боевой базе, только таблица `concept_graph.concepts`, только колонки `code`, `name_en`, `name_en_status`. Других таблиц запрос не касался.

Решение пилота 01.11: список допустимых статусов и его версию ведёт РП596.

Колонок `name_en_publishable` и `name_en_publishable_rules_version` в базе нет. Сессия РП596 01.11 назвала версию списка `name-en-publishable/1`. Список этой версии — статус `ok`. Во всех строках, которые в графе есть, `name_en_publishable_rules_version` = `name-en-publishable/1`. Пустая версия в таблицу не ставится: выгрузчик с пустой версией файл снимка не пишет.

Решение пилота 01.11: таблица ниже принята как эталон. Можно публиковать только при непустом `name_en` и статусе `ok`.

Где английского имени нет, в базе статус всё равно `ok`: колонка `name_en_status` обязательна и по умолчанию `ok`. Среднее поле эталона — это точное значение из базы, не null. Третье поле при пустом имени — false. Пустое имя при статусе `ok`: `name_en` null, `name_en_status_raw` ok, `name_en_publishable` false.

## 19 кодов

| № | Код | name_en | name_en_status_raw | name_en_publishable | name_en_publishable_rules_version |
|---|-----|---------|--------------------|---------------------|-----------------------------------|
| 1 | DP.SC.045 | Constraint Analysis (TOC) | ok | true | name-en-publishable/1 |
| 2 | ECO.PRIN.001 | строки в графе нет | строки в графе нет | строки в графе нет | строки в графе нет |
| 3 | MIM.M.030 | System Type Classifier | ok | true | name-en-publishable/1 |
| 4 | LS.FORM.007 | Pull request register | ok | true | name-en-publishable/1 |
| 5 | PD.METHOD.008 | Strategizing | ok | true | name-en-publishable/1 |
| 6 | DP.SC.108 | Team Formation | ok | true | name-en-publishable/1 |
| 7 | ECO.FM.001 | ECO.FM.001 | ok | true | name-en-publishable/1 |
| 8 | MIM.M.024 | null | ok | false | name-en-publishable/1 |
| 9 | LS.BC.001 | LS.BC.001 | ok | true | name-en-publishable/1 |
| 10 | PD.SOTA.008 | null | ok | false | name-en-publishable/1 |
| 11 | ZP.1 | Axiomaticity | ok | true | name-en-publishable/1 |
| 12 | ZP.2 | Structurality and Symmetries | ok | true | name-en-publishable/1 |
| 13 | U.Entity | Entity | ok | true | name-en-publishable/1 |
| 14 | U.Method | Method | ok | true | name-en-publishable/1 |
| 15 | U.Role | Role | ok | true | name-en-publishable/1 |
| 16 | AR.D.005 | строки в графе нет | строки в графе нет | строки в графе нет | строки в графе нет |
| 17 | AR.008 | null | ok | false | name-en-publishable/1 |
| 18 | VR.FM.002 | False Confidence | ok | true | name-en-publishable/1 |
| 19 | VR.BC.001 | Bounded Context — Verification and Acceptance | ok | true | name-en-publishable/1 |

Пустое `name_en` при статусе `ok`: MIM.M.024, PD.SOTA.008, AR.008. Кода в таблице нет: ECO.PRIN.001, AR.D.005.

У ECO.FM.001 и LS.BC.001 английское имя в базе равно самому коду. Так и записано. Решение пилота 01.11: канарейка снимка — VR.FM.002. AR.D.005 в графе нет, канарейкой он больше не служит.

## Класс «английское имя есть, статус публикацию не допускает»

Тот же запрос искал до двух кодов со статусом `flagged` и один со статусом `pending`, у которых `name_en` не пустое, и эти коды не из списка 19. Строк не нашлось. Графа остаётся пустой: в боевой таблице нет понятия с непустым английским именем и статусом `flagged` или `pending`. Другой запрос не делался.
