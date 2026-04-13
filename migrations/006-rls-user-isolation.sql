-- Migration 006: Row-Level Security для изоляции пользовательских данных
-- WP-212 B4.22-1
--
-- Механизм: Вариант A (Supabase-паттерн)
--   Приложение устанавливает SET LOCAL app.user_id = $ory_id внутри транзакции.
--   RLS-политики читают current_user_id() и фильтруют строки автоматически.
--
-- NULL-guard: user_id IS NULL = платформенный документ, виден всем.
--   Если app.user_id не установлен (прямой запрос) — current_user_id() = NULL
--   → видны только платформенные документы (fail safe, не fail open).
--
-- Применять: psql (unpooled Neon endpoint) < migrations/006-rls-user-isolation.sql

-- ---------------------------------------------------------------------------
-- Вспомогательная функция: читает app.user_id из локальной настройки сессии
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_user_id() RETURNS TEXT AS $$
  -- missing_ok=true: если настройка не установлена — возвращает NULL (не ошибку)
  SELECT current_setting('app.user_id', true)::TEXT;
$$ LANGUAGE SQL STABLE;

-- ---------------------------------------------------------------------------
-- documents: основная таблица знаний
-- ---------------------------------------------------------------------------
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

-- Все подключения (включая сервисную роль) — применять политику
ALTER TABLE documents FORCE ROW LEVEL SECURITY;

-- Политика чтения:
--   user_id IS NULL  → платформенный документ, виден всем
--   user_id = текущий пользователь → личный документ, виден только ему
--   current_user_id() IS NULL → нет SET LOCAL → виден только user_id IS NULL
CREATE POLICY documents_user_isolation ON documents
  FOR ALL
  USING (
    user_id IS NULL
    OR user_id = current_user_id()
  );

-- ---------------------------------------------------------------------------
-- user_sources: личные репозитории пользователей
-- ---------------------------------------------------------------------------
ALTER TABLE user_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sources FORCE ROW LEVEL SECURITY;

-- user_sources всегда принадлежат конкретному пользователю (нет платформенных)
-- Если current_user_id() IS NULL → никто не видит личные источники (fail safe)
CREATE POLICY user_sources_isolation ON user_sources
  FOR ALL
  USING (user_id = current_user_id());

-- ---------------------------------------------------------------------------
-- github_installations: привязка GitHub App installation к пользователю
-- ---------------------------------------------------------------------------
ALTER TABLE github_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_installations FORCE ROW LEVEL SECURITY;

CREATE POLICY github_installations_isolation ON github_installations
  FOR ALL
  USING (user_id = current_user_id());

-- ---------------------------------------------------------------------------
-- concept_graph.learner_concept_mastery: прогресс обучения пользователя
-- ---------------------------------------------------------------------------
ALTER TABLE concept_graph.learner_concept_mastery ENABLE ROW LEVEL SECURITY;
ALTER TABLE concept_graph.learner_concept_mastery FORCE ROW LEVEL SECURITY;

CREATE POLICY learner_mastery_isolation ON concept_graph.learner_concept_mastery
  FOR ALL
  USING (user_id = current_user_id());

-- concept_graph.concepts и concept_graph.concept_edges — платформенные таблицы
-- (нет поля user_id, данные общие для всех). RLS не применяется.
-- Защита через grants/permissions (сервисная роль — write, клиент — read-only).
