-- WP-242 Ф9.2 Backfill: guide concepts missed by buggy regex (42 files with colon-inside-bold)
-- Applied manually to production DB 2026-05-19, then committed as artifact.
-- Idempotent: ON CONFLICT DO NOTHING skips already-present codes.

BEGIN;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.377', 'неудовлетворенность', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/03-satisfying-role-interests-and-personal-dissatisfactions.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.378', '«связь психологии и системного мышления»', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/03-satisfying-role-interests-and-personal-dissatisfactions.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.379', 'должность', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/10-position-role-career.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.380', 'звание', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/10-position-role-career.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.381', 'квалификация', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/10-position-role-career.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.382', 'карьера', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/10-position-role-career.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.383', 'профессиональный и должностной рост', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/10-position-role-career.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.384', 'карьерист', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/10-position-role-career.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.385', 'создатель', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/10-position-role-career.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.386', 'системные изменения', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/10-position-role-career.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.387', 'деятельностный кругозор', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/09-activity-outlook.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.388', 'кругозор', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/09-activity-outlook.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.389', 'разделение труда', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/09-activity-outlook.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.390', 'деятельность', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/09-activity-outlook.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.391', 'предметная область', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/09-activity-outlook.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.392', 'трансдисциплина', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/09-activity-outlook.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.393', 'интеллект-стек', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/09-activity-outlook.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.394', 'понятия', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/09-activity-outlook.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.395', 'приемы мышления', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/09-activity-outlook.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.396', 'вид деятельности', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/09-activity-outlook.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.397', 'стадии жизнедеятельности — потребление информации', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/05-stages-and-methods-practices-of-self-development.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.398', 'размышления', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/05-stages-and-methods-practices-of-self-development.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.399', 'личное стратегирование', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/05-stages-and-methods-practices-of-self-development.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.400', 'планирование работ', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/05-stages-and-methods-practices-of-self-development.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.401', 'реализация', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/05-stages-and-methods-practices-of-self-development.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.402', 'досуг', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/05-stages-and-methods-practices-of-self-development.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.403', '«стадии жизнедеятельности бесконечно-развивающегося создателя»', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/05-stages-and-methods-practices-of-self-development.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.404', '«мысли — идеи — системы и проекты — работы — рабочие продукты — досуг»', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/05-stages-and-methods-practices-of-self-development.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.405', 'метод (практика)', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/04-actions-by-role-method-practice.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.406', 'исполнитель роли', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/04-actions-by-role-method-practice.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.407', 'роль', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/04-actions-by-role-method-practice.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.408', 'ролевой интерес', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/04-actions-by-role-method-practice.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.409', 'система', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/04-actions-by-role-method-practice.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.410', 'ролевое мастерство', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/06-what-is-role-mastery.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.411', 'методы ролевого мастерства', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/06-what-is-role-mastery.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.412', 'выявление ролей', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/07-role-mastery-techniques.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.413', 'вход в роль', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/07-role-mastery-techniques.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.414', 'выход из роли', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/07-role-mastery-techniques.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.415', 'самоконтроль', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/07-role-mastery-techniques.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.416', 'собранность', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/07-role-mastery-techniques.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.417', 'проектная роль', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/02-role-interests.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.418', 'ролевой интерес или интерес к системе', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/02-role-interests.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.419', 'внешние и внутренние проектная роль', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/02-role-interests.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.420', '«интерес-роль-практика-рабочий продукт»', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/02-role-interests.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.421', 'агент', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.422', 'инвестирование времени', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.423', 'интерес к системе', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.424', 'изменения', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.425', 'мастерство', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.426', 'метод', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.427', 'потребление информации', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.428', 'ролевое поведение', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.429', 'систематичность', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.430', 'стадии жизнедеятельности бесконечно-развивающегося создателя', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.431', 'связь психологии и системного мышления', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.432', 'театральная метафора', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.433', 'внимание в моменте', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/08-self-control-and-attention-in-the-moment.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.434', '«театральная метафора»', 'guide', '1-1-self-development', 'personal/1-1-self-development/05-role-role-mastery-and-method/01-what-is-a-role.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.435', 'траектория жизни', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/10-trajectory-of-life.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.436', 'культура МИМ', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/10-trajectory-of-life.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.437', 'личность', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/10-trajectory-of-life.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.438', 'системные уровни', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/10-trajectory-of-life.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.439', 'сообщество единомышленников', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/10-trajectory-of-life.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.440', 'культура обучения', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/10-trajectory-of-life.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.441', 'систематические изменения', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/07-how-to-empower-yourself-to-change.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.442', 'тренировки', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/07-how-to-empower-yourself-to-change.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.443', 'итерация', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/07-how-to-empower-yourself-to-change.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.444', 'инкремент', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/07-how-to-empower-yourself-to-change.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.445', 'привычки', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/07-how-to-empower-yourself-to-change.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.446', 'мировоззрение', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/07-how-to-empower-yourself-to-change.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.447', 'культ SoTA', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/07-how-to-empower-yourself-to-change.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.448', 'личность как целевая система', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/06-systematic-personal-development-project.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.449', 'проект системного саморазвития личности', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/06-systematic-personal-development-project.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.450', 'бесконечное развитие', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/06-systematic-personal-development-project.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.451', 'приоритетные проекты', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/06-systematic-personal-development-project.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.452', 'саморазвитие', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/06-systematic-personal-development-project.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.453', 'психотерапия', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/06-systematic-personal-development-project.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.454', 'жизненное мастерство', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/06-systematic-personal-development-project.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.455', 'элита', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/09-elite.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.456', 'агентность', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/09-elite.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.457', 'ресурсы', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/09-elite.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.458', 'общество', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/09-elite.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.459', 'человечество', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/09-elite.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.460', 'великая идея', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/02-supergoals-and-great-ideas.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.461', 'сверхцель', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/02-supergoals-and-great-ideas.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.462', 'сверхзадача', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/02-supergoals-and-great-ideas.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.463', 'калибр личности', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/02-supergoals-and-great-ideas.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.464', 'семья', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/02-supergoals-and-great-ideas.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.465', 'задачи', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/02-supergoals-and-great-ideas.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.466', 'личные цели', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/02-supergoals-and-great-ideas.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.467', 'воспитание', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/02-supergoals-and-great-ideas.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.468', 'счастье', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/03-happiness.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.469', 'успех', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/03-happiness.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.470', 'интересная жизнь', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/03-happiness.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.471', 'инженерия', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/03-happiness.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.472', 'неудовлетворенности', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/03-happiness.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.473', 'счастливая жизнь', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/03-happiness.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.474', 'сбалансированность', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/03-happiness.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.475', 'характеристики личности', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/03-happiness.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.476', 'непрерывное развитие', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/05-continuous-and-endless-development.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.477', 'культура', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/05-continuous-and-endless-development.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.478', 'техноэволюция', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/05-continuous-and-endless-development.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.479', 'свобода воли', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/05-continuous-and-endless-development.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.480', 'впечатления', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.481', 'заинтересованные лица', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.482', 'осознанная жизнь', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.483', 'переживания', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.484', 'радость', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.485', 'роли', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.486', 'смысл жизни', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.487', 'удержание внимания', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.488', 'успешная система', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.489', 'интегральный успех', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/04-success-and-integral-success.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.490', 'деньги', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/04-success-and-integral-success.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.491', 'жизнь', 'guide', '1-1-self-development', 'personal/1-1-self-development/09-personal-development-trajectory/01-human-life.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.492', 'искусственный интеллект как исполнитель роли', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/06-artificial-intelligence.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.493', 'искусственный интеллект как часть личности', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/06-artificial-intelligence.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.494', 'мышление', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/06-artificial-intelligence.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.495', 'ИИ-агент', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/06-artificial-intelligence.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.496', 'желания', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/03-fundamental-cause-of-anxiety-depression-and-burnout.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.497', 'способности', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/03-fundamental-cause-of-anxiety-depression-and-burnout.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.498', 'знания', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/03-fundamental-cause-of-anxiety-depression-and-burnout.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.499', 'выгорание', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/03-fundamental-cause-of-anxiety-depression-and-burnout.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.500', 'эшелонированная оборона', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/03-fundamental-cause-of-anxiety-depression-and-burnout.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.501', 'практика организации досуга', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/03-fundamental-cause-of-anxiety-depression-and-burnout.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.502', 'практика учета и инвестирования времени', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/03-fundamental-cause-of-anxiety-depression-and-burnout.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.503', 'этика и успешная система', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/08-ethics-and-systems-thinking.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.504', 'корпоративная культура', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/08-ethics-and-systems-thinking.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.505', 'системное мышление', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/08-ethics-and-systems-thinking.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.506', 'сострадание', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/09-compassion-and-systemic-leadership.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.507', 'системное лидерство', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/09-compassion-and-systemic-leadership.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.508', 'эмоциональная часть личности', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/09-compassion-and-systemic-leadership.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.509', 'лидер', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/09-compassion-and-systemic-leadership.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.510', 'намерение', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/05-two-keys-for-human-action.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.511', 'мотивация', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/05-two-keys-for-human-action.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.512', 'человек', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/05-two-keys-for-human-action.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.513', 'AI', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/05-two-keys-for-human-action.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.514', 'этика', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/07-ethics-morality-and-dissatisfaction.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.515', 'мораль', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/07-ethics-morality-and-dissatisfaction.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.516', 'этика технологий', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/07-ethics-morality-and-dissatisfaction.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.517', 'консьюмеризм', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/07-ethics-morality-and-dissatisfaction.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.518', 'консеквенциональная этика', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/07-ethics-morality-and-dissatisfaction.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.519', 'деонтологическая этика', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/07-ethics-morality-and-dissatisfaction.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.520', 'неожиданность', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/02-surprises-and-the-principle-of-optimism.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.521', 'неопределенность', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/02-surprises-and-the-principle-of-optimism.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.522', 'принцип оптимизма', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/02-surprises-and-the-principle-of-optimism.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.523', 'познание', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/02-surprises-and-the-principle-of-optimism.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.524', 'ответственность', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/10-liability-and-fatal-error.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.525', '«шкура на кону»', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/10-liability-and-fatal-error.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.526', 'этичное решение', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/10-liability-and-fatal-error.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.527', 'фатальная ошибка', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/10-liability-and-fatal-error.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.528', 'удача', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/10-liability-and-fatal-error.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.529', 'автономность', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.530', 'вычислительная мощность', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.531', 'интеллект', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.532', 'модель личности', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.533', 'мозг', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.534', 'намерения', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.535', 'организм', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.536', 'предпочтения', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.537', 'привычка', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.538', 'принятие решений', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.539', 'скорость мышления (вычислений)', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.540', 'способность к принятию решений', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.541', 'тело', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.542', 'характеристики личности (характер)', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.543', 'целенаправленность', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.544', 'экзокортекс', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.545', 'экзотело', 'guide', '1-1-self-development', 'personal/1-1-self-development/08-personality-and-agent-human-and-ai/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.546', 'понятийное наведение внимания', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/10-attention-in-the-moment-as-a-basis-for-systemic-change-and-productivity.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.547', 'стоп-момент', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/10-attention-in-the-moment-as-a-basis-for-systemic-change-and-productivity.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.548', 'ритуал практики инвестирования и учета времени', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/10-attention-in-the-moment-as-a-basis-for-systemic-change-and-productivity.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.549', 'внимание', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.550', 'управление вниманием', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.551', 'рациональная работа', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.552', 'рациональность', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.553', 'онтологика', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.554', 'минимизация отвлечений', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.555', 'Full Kitting', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.556', 'концентрация', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.557', 'учет времени', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.558', 'распознавание ошибок', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.559', 'исправление ошибок', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.560', 'интуиция', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.561', 'обратная связь', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.562', 'продуктивность', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.563', 'фокусировка', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.564', 'временные масштабы внимания', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.565', 'утечки ресурса собранности', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.566', 'эмоциональные факторы', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.567', 'когнитивные перегрузки', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.568', 'восприятие', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.569', 'ограниченность внимания', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.570', 'наведение внимания', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.571', 'переключение внимания', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.572', 'мультимодальное внимание', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.573', 'виды внимания', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.574', 'первая сигнальная система (быстрое мышление', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.575', 'внимание S1)', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.576', 'внимание в моменте (стоп-момент)', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.577', 'вторая сигнальная система (медленное мышление', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.578', 'внимание S2)', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.579', 'информационная перегрузка', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.580', 'эмоциональное состояние', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.581', 'эшелонированный досуг', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.582', 'время', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.583', 'фокус', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.584', 'отвлечения', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.585', 'недостаток ресурсов', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.586', 'расфокусировка', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.587', 'фильтрация информации', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.588', 'стратегирование и планирование', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.589', 'автоматическое внимание', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.590', 'понятийное внимание', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.591', 'заземление (граундинг)', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.592', 'системность', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.593', 'причинность', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.594', 'эмерджентность', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.595', 'коллективная синхронизация внимания', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.596', 'методы обучения', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.597', 'практики саморазвития', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.598', 'временные масштабы обучения', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.599', 'цифровая перегрузка', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.600', 'планирование задач', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.601', 'интеграция технологий', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.602', 'базы знаний', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.603', 'адаптация к изменениям', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.604', 'киберличность', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.605', 'разобранность', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.606', 'хаос', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.607', 'гиперфокусировка', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.608', 'креативность', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.609', 'баланс между собранностью и гибкостью', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.610', 'осознанная постановка практик саморазвития', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/13-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.611', 'первая сигнальная система (внимание S1)', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/02-attention.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.612', 'интуитивность', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/02-attention.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.613', 'автоматизация', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/02-attention.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.614', 'вторая сигнальная система (внимание S2)', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/02-attention.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.615', 'ограничения внимания', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/02-attention.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.616', 'осознанность', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/02-attention.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.617', 'жизненные вызовы', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/02-attention.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.618', 'стратегирование', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/09-exocortex-for-composure.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.619', 'временные масштабы внимания (краткосрочные', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/05-time-scales-of-attention.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.620', 'среднесрочные', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/05-time-scales-of-attention.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.621', 'долгосрочные)', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/05-time-scales-of-attention.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.622', 'внимание S1', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/05-time-scales-of-attention.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.623', 'внимание S2', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/05-time-scales-of-attention.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.624', 'управление фокусом', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/05-time-scales-of-attention.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.625', 'корректировка целей', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/05-time-scales-of-attention.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.626', 'перегрузка информации', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/06-loss-of-attention.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.627', 'неоптимальная организация работы', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/06-loss-of-attention.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.628', 'управление ограниченными ресурсами', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/08-composure-in-learning.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.629', 'чрезмерная собранность', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/11-the-dark-side-of-concentration.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.630', 'cосредоточенность на физических и ментальных объектах', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/07-conceptual-attention.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.631', 'практическое применение понятийного внимания', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/07-conceptual-attention.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.632', 'моделирование', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/04-efficient-work.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.633', 'текущие задачи', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/03-important-current-and-urgent.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.634', 'срочные задачи', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/03-important-current-and-urgent.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.635', 'важные задачи', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/03-important-current-and-urgent.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.636', 'фокус и удержание внимания', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/03-important-current-and-urgent.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.637', 'минимизация потерь ресурсов', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/03-important-current-and-urgent.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.638', 'осознанное реагирование', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/03-important-current-and-urgent.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.639', 'расширенное восприятие', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/12-cyber-personality.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.640', 'память', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/12-cyber-personality.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.641', 'эмоции', 'guide', '1-1-self-development', 'personal/1-1-self-development/03-composure-and-attention/12-cyber-personality.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.642', 'осознанное времяпрепровождение', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/10-conscious-pastime-and-organization-of-leisure-time.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.643', 'досуг и отдых', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/10-conscious-pastime-and-organization-of-leisure-time.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.644', 'активный и пассивный досуг', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/10-conscious-pastime-and-organization-of-leisure-time.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.645', '«цикл работа — досуг»', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/10-conscious-pastime-and-organization-of-leisure-time.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.646', 'долголетие', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/11-life-extension-and-human-aesthetics.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.647', 'здоровье', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/11-life-extension-and-human-aesthetics.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.648', 'сон', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/11-life-extension-and-human-aesthetics.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.649', 'техобслуживание организма', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/11-life-extension-and-human-aesthetics.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.650', 'эстетика', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/11-life-extension-and-human-aesthetics.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.651', 'умение учиться', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/06-career-guidance.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.652', 'профориентация', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/06-career-guidance.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.653', 'принцип свободы выбора', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/06-career-guidance.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.654', 'врожденный и приобретенный интеллект', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/03-intelligence-stack.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.655', 'биологический интеллект', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/03-intelligence-stack.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.656', 'дисциплина', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/03-intelligence-stack.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.657', 'роль ученика', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/05-ability-to-learn-ability-to-think-ability-to-do.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.658', 'умение думать', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/05-ability-to-learn-ability-to-think-ability-to-do.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.659', 'умение делать', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/05-ability-to-learn-ability-to-think-ability-to-do.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.660', 'мыслительное мастерство', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/05-ability-to-learn-ability-to-think-ability-to-do.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.661', 'прикладное (профессиональное мастерство)', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/05-ability-to-learn-ability-to-think-ability-to-do.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.662', 'форма обучения', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/05-ability-to-learn-ability-to-think-ability-to-do.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.663', 'содержание обучения', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/05-ability-to-learn-ability-to-think-ability-to-do.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.664', 'осознанное управление временем', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/08-time.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.665', 'принципы времени', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/08-time.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.666', 'трата времени', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/08-time.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.667', 'потеря времени', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/08-time.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.668', 'продление жизни', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/08-time.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.669', 'работа', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/08-time.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.670', 'неидеальные условия', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/08-time.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.671', 'искусство', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/04-culture.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.672', 'методы ученика', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/04-culture.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.673', 'новая грамотность', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/04-culture.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.674', 'животное мышление', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.675', 'интуитивное мышление', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.676', 'информация', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.677', 'квадрант компетенций', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.678', 'машинное мышление', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.679', 'модели обучения', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.680', 'накопительный эффект', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.681', 'неосознанная компетентность', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.682', 'неосознанная некомпетентность', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.683', 'образование', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.684', 'образованность', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.685', 'обучение', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.686', 'обывательское мышление', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.687', 'осознанная компетентность', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.688', 'осознанная некомпетентность', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.689', 'осознанное и неосознанное обучение', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.690', 'отрицательная полезность труда', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.691', 'принципы свободы', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.692', 'выбора', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.693', 'профессионализм', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.694', 'спектр формальности мышления', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.695', 'убеждения', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.696', 'факты', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.697', 'формальное мышление', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.698', 'этапы постановки привычки — «Надо или любопытно»', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.699', '«Могу»', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.700', '«Хочу»', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.701', '«Не могу не»', 'guide', '1-1-self-development', 'personal/1-1-self-development/02-training-and-time/12-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.702', 'картина мира', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/02-theory-models-and-descriptions-of-reality.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.703', 'научные и ненаучные картины мира', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/02-theory-models-and-descriptions-of-reality.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.704', 'вероятность предсказания', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/02-theory-models-and-descriptions-of-reality.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.705', 'теория', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/02-theory-models-and-descriptions-of-reality.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.706', 'модель', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/02-theory-models-and-descriptions-of-reality.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.707', 'описание', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/02-theory-models-and-descriptions-of-reality.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.708', 'SoTA', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/02-theory-models-and-descriptions-of-reality.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.709', 'рабочий продукт', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/08-life-mastery.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.710', 'предмет метода', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/08-life-mastery.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.711', 'интеллект или мыслительное мастерство', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/08-life-mastery.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.712', 'прикладное (профессиональное) мастерство', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/08-life-mastery.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.713', 'инструмент', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/08-life-mastery.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.714', 'интеллектуал', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/08-life-mastery.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.715', 'профессионал', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/08-life-mastery.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.716', 'проблема', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/08-life-mastery.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.717', 'задача', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/08-life-mastery.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.718', 'мемы', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/03-technoevolution.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.719', 'второй мозг', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/03-technoevolution.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.720', 'свободное время', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/03-technoevolution.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.721', 'простота для пользователя', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/07-pros-and-cons-of-progress.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.722', 'сложность для создателя', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/07-pros-and-cons-of-progress.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.723', 'расслоение общества', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/07-pros-and-cons-of-progress.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.724', 'поведение создателя', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/07-pros-and-cons-of-progress.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.725', 'поведение потребителя', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/07-pros-and-cons-of-progress.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.726', 'прогресс', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/07-pros-and-cons-of-progress.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.727', 'мастерство создания систем', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/04-creator-changing-the-world-for-the-better.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.728', 'быстрое и медленное мышление', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/09-thinking-and-intelligence.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.729', 'экзокортекс и экзотело', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/09-thinking-and-intelligence.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.730', 'социальная среда', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/06-social-environment.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.731', 'профессиональное мастерство', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/05-man-body-and-personality.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.732', 'ментальное пространство', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.733', 'SoTA (State of the Art)', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.734', 'физический мир', 'guide', '1-1-self-development', 'personal/1-1-self-development/01-physical-world-and-mental-space/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.735', 'создатель системы', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.736', 'принципы инженерии', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.737', 'безмасштабность и непрерывность', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.738', 'инженер', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.739', 'классический инженер', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.740', 'инженеры целевой системы', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.741', 'менеджмент', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.742', 'предпринимательство', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.743', 'инженерия клиентуры', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.744', 'инженерия целевой системы', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.745', 'инженерия систем создания', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.746', 'продвиженец', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.747', 'визионер', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.748', 'бизнесмен', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.749', 'стратег', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.750', 'основатель', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.751', 'инноватор', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.752', 'мем', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.753', 'системный менеджмент', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.754', 'операционный менеджер', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.755', 'менеджер оргразвития', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.756', 'топ-менеджер', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.757', 'директор по развитию', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.758', 'директор по развитию себя', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.759', 'современная корпоративная культура или инженерная культура или инженерно-корпоративная культура', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.760', 'методы корпоративной культуры', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.761', 'траектория развития', 'guide', '1-1-self-development', 'personal/1-1-self-development/07-engineering-management-entrepreneurship/10-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.762', 'воспоминания', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/09-memories-and-memory.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.763', 'психология', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/01-psychology-and-systems-approach.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.764', 'системный подход', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/01-psychology-and-systems-approach.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.765', 'состояния системы', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/04-human-conditions.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.766', 'состояния человека', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/04-human-conditions.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.767', 'характеристики системы', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/04-human-conditions.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.768', 'ролевое состояние (роль)', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/04-human-conditions.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.769', 'психологическое состояние', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/04-human-conditions.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.770', 'физическое состояние', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/04-human-conditions.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.771', 'переходы между состояниями', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/04-human-conditions.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.772', 'системы создания', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/04-human-conditions.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.773', 'чувства', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/07-emotional-stability-the-basis-of-endless-development.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.774', 'эмоциональную стабильность', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/07-emotional-stability-the-basis-of-endless-development.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.775', 'стрессоустойчивость', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/07-emotional-stability-the-basis-of-endless-development.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.776', 'принцип свободной энергии', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/03-dissatisfaction.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.777', 'характеристика человека', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/03-dissatisfaction.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.778', 'инженерия человека', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.779', 'степень мастерства', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.780', 'ресурсность', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.781', 'эмоциональная стабильность', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.782', 'ощущения', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.783', 'теории активного вывода (Active Inference)', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.784', 'удовольствие', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.785', 'характеристика системы (предмет интереса)', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/05-human-characteristics-in-a-systemic-context.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.786', 'характеристики человека', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/05-human-characteristics-in-a-systemic-context.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.787', '(стрессоустойчивость)', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/05-human-characteristics-in-a-systemic-context.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.788', 'свободная энергия', 'guide', '1-1-self-development', 'personal/1-1-self-development/04-systematic-approach-in-personality-psychology/08-motivation-and-intentions.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.789', 'понятия системного мышления', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/03-systems-thinking-concepts.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.790', 'понятие', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/03-systems-thinking-concepts.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.791', 'термин', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/03-systems-thinking-concepts.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.792', 'слово', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/03-systems-thinking-concepts.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.793', 'человек в системном рассмотрении', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/09-man-in-systemic-consideration.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.794', 'системное мировоззрение', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/02-systemic-worldview.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.795', 'STEM', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/02-systemic-worldview.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.796', 'сложные проблемы', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/02-systemic-worldview.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.797', 'баланс между работой и личной жизнью', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/02-systemic-worldview.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.798', 'системный подход 2.0', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/05-systematic-approach.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.799', 'системный подход 3.0', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/05-systematic-approach.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.800', 'проектные роли', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/05-systematic-approach.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.801', 'системное описание', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/05-systematic-approach.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.802', 'учесть и удовлетворить интересы', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/05-systematic-approach.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.803', 'неустроенности', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/05-systematic-approach.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.804', 'безмасштабность', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/05-systematic-approach.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.805', 'системные навыки', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/10-systems-skills-and-thinking-techniques.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.806', 'целевая система', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/07-types-of-systems.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.807', 'надсистема', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/07-types-of-systems.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.808', 'системы в окружении', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/07-types-of-systems.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.809', 'подсистемы', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/07-types-of-systems.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.810', 'наша система', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/07-types-of-systems.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.811', '4D', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.812', 'вложенность', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.813', 'воплощение системы', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.814', 'документация системы', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.815', 'метасистемный переход', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.816', 'модель системы', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.817', 'проект', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.818', 'свойства системы', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.819', 'системный подход 1.0', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.820', 'физическая вложенность', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.821', 'физичность системы', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.822', 'целостность', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/11-section-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.823', 'описание системы', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/06-implementation-description-and-documentation-of-the-system.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.824', 'цель', 'guide', '1-1-self-development', 'personal/1-1-self-development/06-what-is-systems-thinking/08-system-and-project.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.825', 'системное мышление 2.0', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/01-what-is-systems-thinking-and-why-does-modern-man-need-it/12-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.826', 'классические свойства системы: целостность', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/01-what-is-systems-thinking-and-why-does-modern-man-need-it/12-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.827', 'прикладные практики', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/01-what-is-systems-thinking-and-why-does-modern-man-need-it/12-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.828', 'прикладное мастерство', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/01-what-is-systems-thinking-and-why-does-modern-man-need-it/12-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.829', '| Принципы', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/01-what-is-systems-thinking-and-why-does-modern-man-need-it/16-modeling-12-discipline-theory-model.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.830', 'модели | Роли | Рабочий продукт | Заметки |', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/01-what-is-systems-thinking-and-why-does-modern-man-need-it/16-modeling-12-discipline-theory-model.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.831', 'области интересов', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/05-system-levels-creation-chains-areas-of-interest/10-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.832', 'область интересов надсистемы', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/05-system-levels-creation-chains-areas-of-interest/10-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.833', 'целевой системы', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/05-system-levels-creation-chains-areas-of-interest/10-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.834', 'создателя', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/05-system-levels-creation-chains-areas-of-interest/10-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.835', 'предметные области интересов предпринимателя', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/05-system-levels-creation-chains-areas-of-interest/10-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.836', 'инженера и менеджера', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/05-system-levels-creation-chains-areas-of-interest/10-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.837', 'деятельностные роли', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/05-system-levels-creation-chains-areas-of-interest/10-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.838', 'системное разбиение', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/05-system-levels-creation-chains-areas-of-interest/10-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.839', 'мета-системный переход', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/05-system-levels-creation-chains-areas-of-interest/10-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.840', 'цепочка создания', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/05-system-levels-creation-chains-areas-of-interest/10-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.841', 'деантропоморфность', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/05-system-levels-creation-chains-areas-of-interest/10-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.842', 'многоуровневая эволюция', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/05-system-levels-creation-chains-areas-of-interest/10-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.843', 'роль=ролевой объект=функциональный объект', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/03-roles-and-a-successful-system/13-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.844', 'практика', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/03-roles-and-a-successful-system/13-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.845', 'предмет интереса', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/03-roles-and-a-successful-system/13-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.846', 'архитектурные характеристики', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/03-roles-and-a-successful-system/13-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.847', 'предпочтение', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/03-roles-and-a-successful-system/13-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.848', 'физический объект=исполнитель', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/03-roles-and-a-successful-system/13-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.849', 'функциональный объект=роль', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/03-roles-and-a-successful-system/13-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.850', 'ролевое поведение=функциональное поведение', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/03-roles-and-a-successful-system/13-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.851', 'черный и прозрачный ящики', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/03-roles-and-a-successful-system/13-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.852', 'организация', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/03-roles-and-a-successful-system/13-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.853', 'организационные места=должности', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/03-roles-and-a-successful-system/13-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.854', 'оргзвено', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/03-roles-and-a-successful-system/13-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.855', 'системы окружения', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/04-types-of-systems-target-system-supersystem-creation-systems-and-others/12-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.856', 'система-создатель', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/04-types-of-systems-target-system-supersystem-creation-systems-and-others/12-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.857', 'подсистема', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/04-types-of-systems-target-system-supersystem-creation-systems-and-others/12-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.858', 'поведение', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/04-types-of-systems-target-system-supersystem-creation-systems-and-others/12-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.859', 'процесс', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/04-types-of-systems-target-system-supersystem-creation-systems-and-others/12-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.860', 'функция', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/04-types-of-systems-target-system-supersystem-creation-systems-and-others/12-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.861', 'сервис', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/04-types-of-systems-target-system-supersystem-creation-systems-and-others/12-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.862', 'метод описания', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/06-system-modeling/17-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.863', 'метамодель', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/06-system-modeling/17-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.864', 'мультимодель', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/06-system-modeling/17-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.865', 'мега-модель', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/06-system-modeling/17-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.866', 'функциональный=ролевой=аналитический', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/06-system-modeling/17-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.867', 'модульный=конструктивный=синтетический', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/06-system-modeling/17-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.868', 'пространственный=места=размещения', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/06-system-modeling/17-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.869', 'стоимостной=экономический=ресурсный', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/06-system-modeling/17-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.870', 'функциональное описание', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/06-system-modeling/17-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.871', 'модульное описание', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/06-system-modeling/17-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.872', 'пространственное описание', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/06-system-modeling/17-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.873', 'функциональный объект=ролевой объект', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/02-implementation-and-description-of-the-system/11-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.874', 'ролевое поведение=функция=назначение в окружении (назначение системы)', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/02-implementation-and-description-of-the-system/11-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.875', 'физический объект=исполнитель роли=модуль', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/02-implementation-and-description-of-the-system/11-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.876', 'наименование систем', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/02-implementation-and-description-of-the-system/11-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.877', 'отношение «часть-целое»=отношение состава/сборки', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/02-implementation-and-description-of-the-system/11-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO concept_graph.concepts (code, name, level, domain, source_doc, source_repo, status, misconception)
VALUES ('GUIDE.878', 'сложная система', 'guide', '1-3-systems-thinking-introduction', 'personal/1-3-systems-thinking-introduction/02-implementation-and-description-of-the-system/11-section-conclusions-and-basic-concepts-summary.md', 'docs-courses', 'active', false)
ON CONFLICT (code) DO NOTHING;
COMMIT;
