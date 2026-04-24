-- WP-242 Ф8.4: Graph-as-runtime-instrument
-- SC: DP.SC.121 (актуальная онтология в ответах агентов)
-- Method: DP.METHOD.042 (сценарии использования графа)
-- Role: R?? graph-traversal-tool (Ф8.3 — назначается при выделении роли)
--
-- Что добавляет:
--   1. concept_graph.concepts: superseded_by, misconception — поддержка жизненного
--      цикла концепта + явная пометка заблуждений (инвариант mode (a) SC.121)
--   2. concept_graph.concepts.status: расширение CHECK — добавляется 'superseded'
--   3. concept_graph.concept_edges.last_traversed_at — счётчик обхода для Ф8.5 feedback
--   4. schema `health` + `health.graph_usage_events` — observability лог обходов графа
--
-- HD #49 "Системная БД ≠ Health-хранилище": целевая схема — DB `platform` / schema
-- `health`. В MVP схема живёт в той же Neon DB, что и concept_graph. Перенос в
-- отдельную health-DB — после WP-244 Ф? (дата миграции health-DB). Не менять
-- имена schema/таблицы при переносе — только DSN.
--
-- PII (B7.3, ArchGate mitigation): `query_text` НЕ записывается сырым.
-- Сохраняется `query_text_hash` (sha256 hex) + `query_text_normalized_prefix`
-- (первые 40 символов нижнего регистра без PII-меток). Raw query в Langfuse
-- trace (opt-in, self-hosted).

-- =============================================================
-- 1. concept_graph.concepts — superseded_by + misconception
-- =============================================================

ALTER TABLE concept_graph.concepts
  ADD COLUMN IF NOT EXISTS superseded_by BIGINT
    REFERENCES concept_graph.concepts(id) ON DELETE SET NULL;

ALTER TABLE concept_graph.concepts
  ADD COLUMN IF NOT EXISTS misconception BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN concept_graph.concepts.superseded_by IS
  'Если концепт заменён новым — указывает id нового концепта. NULL = актуален';
COMMENT ON COLUMN concept_graph.concepts.misconception IS
  'TRUE = концепт описывает типичное заблуждение (не может использоваться как authoritative-утверждение). Отличается от concept_misconceptions — там ошибки ПРО концепт, здесь концепт САМ по себе — ошибка';

-- Индекс для быстрого фильтра active+non-misconception
CREATE INDEX IF NOT EXISTS idx_concepts_active
  ON concept_graph.concepts(id)
  WHERE status = 'active' AND misconception = FALSE;

-- =============================================================
-- 2. Расширение CHECK status: добавить 'superseded'
-- =============================================================
-- PostgreSQL не поддерживает ALTER CHECK напрямую — DROP + ADD

ALTER TABLE concept_graph.concepts
  DROP CONSTRAINT IF EXISTS concepts_status_check;

ALTER TABLE concept_graph.concepts
  ADD CONSTRAINT concepts_status_check
  CHECK (status IN ('active', 'deprecated', 'draft', 'superseded'));

COMMENT ON COLUMN concept_graph.concepts.status IS
  'active = используется, draft = WIP, deprecated = устарел (но без замены), superseded = заменён новым концептом (см. superseded_by)';

-- =============================================================
-- 3. concept_edges.last_traversed_at — для Ф8.5 "suspicious edges"
-- =============================================================

ALTER TABLE concept_graph.concept_edges
  ADD COLUMN IF NOT EXISTS last_traversed_at TIMESTAMPTZ;

COMMENT ON COLUMN concept_graph.concept_edges.last_traversed_at IS
  'Время последнего обхода ребра в runtime. NULL = ни разу не обходилось с момента Ф8.4. Ребро, не обходившееся N дней, — кандидат в orphan/suspicious в Ф8.5';

CREATE INDEX IF NOT EXISTS idx_edges_last_traversed
  ON concept_graph.concept_edges(last_traversed_at);

-- =============================================================
-- 4. health schema + graph_usage_events
-- =============================================================

CREATE SCHEMA IF NOT EXISTS health;

COMMENT ON SCHEMA health IS
  'Observability данные: логи использования подсистем, health-probe, drift-report metadata. Целевое расположение — DB `platform` (или отдельная DB #8). В MVP живёт в той же Neon DB, что и concept_graph (миграция после WP-244)';

CREATE TABLE IF NOT EXISTS health.graph_usage_events (
  id BIGSERIAL PRIMARY KEY,

  -- Время события
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Контекст запроса (PII-safe)
  query_text_hash TEXT NOT NULL,          -- sha256 hex от нормализованного текста
  query_text_prefix TEXT,                 -- первые 40 символов (PII-фильтр на стороне клиента перед записью)
  scenario TEXT,                          -- из DP.METHOD.042: 'claude-code', 'pack-author', 'portnoy', 'ocenshik', 'navigator', null
  agent_id TEXT,                          -- 'claude-code', 'portnoy', 'ocenshik' — агент, вызвавший tool
  user_id_hash TEXT,                      -- sha256 от Ory identity (если авторизованный)

  -- Что делал с графом
  tool_name TEXT NOT NULL,                -- 'knowledge_concept_expand' | 'knowledge_concept_status' | 'knowledge_concept_search_by_name' | ...
  seed_concept_ids BIGINT[],              -- с каких концептов начался обход
  retrieved_concept_ids BIGINT[],         -- все вернулись в ответе
  cited_concept_ids BIGINT[],             -- агент реально процитировал в ответе пользователю (заполняется если агент сообщит; иначе null)
  edge_types_used TEXT[],                 -- ['specializes','part_of','related']
  traversal_depth INT,                    -- макс. глубина обхода

  -- Инварианты SC.121 — mode (a) base
  stale_citation_count INT NOT NULL DEFAULT 0,       -- цитирование superseded/deprecated
  misconception_as_auth_count INT NOT NULL DEFAULT 0,-- цитирование misconception=true как истины (hard threshold 0)

  -- Инвариант mode (b) — enriched
  mode_b_active BOOLEAN NOT NULL DEFAULT FALSE,
  concept_citation_rate REAL,             -- доля retrieved, реально процитированных (для mode_b_active сценариев)

  -- Производительность
  latency_ms INT NOT NULL,                -- время работы tool от request до response
  fallback_reason TEXT,                   -- 'graph_unavailable' | 'timeout' | 'empty_result' | null (norm)

  -- Результат вызова (для Ragas / Langfuse корреляции)
  trace_id TEXT,                          -- Langfuse trace id, если opt-in активен

  -- Версия схемы концептов — для воспроизводимости drift-repor
  graph_build_id TEXT                     -- id последней пересборки графа (из будущей health.graph_build_events)
);

-- Индексы для dashboards/отчётов
CREATE INDEX IF NOT EXISTS idx_graph_usage_created ON health.graph_usage_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_graph_usage_tool ON health.graph_usage_events(tool_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_graph_usage_scenario ON health.graph_usage_events(scenario, created_at DESC) WHERE scenario IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_graph_usage_stale ON health.graph_usage_events(created_at DESC) WHERE stale_citation_count > 0;
CREATE INDEX IF NOT EXISTS idx_graph_usage_misc ON health.graph_usage_events(created_at DESC) WHERE misconception_as_auth_count > 0;
CREATE INDEX IF NOT EXISTS idx_graph_usage_fallback ON health.graph_usage_events(created_at DESC) WHERE fallback_reason IS NOT NULL;

COMMENT ON TABLE health.graph_usage_events IS
  'Лог обходов графа концептов. Writer: knowledge-mcp. Reader: Metabase/Grafana dashboards + Ф8.5 weekly drift-report. Hard threshold: misconception_as_auth_count = 0 (любое срабатывание = инцидент). Soft: stale_citation_count / total_citations ≤ 2%';

-- =============================================================
-- 5. updated_at trigger — чтобы superseded_by / misconception
--    автоматически обновляли updated_at
-- =============================================================

CREATE OR REPLACE FUNCTION concept_graph.touch_concept_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_concepts_touch_updated_at ON concept_graph.concepts;
CREATE TRIGGER trg_concepts_touch_updated_at
  BEFORE UPDATE ON concept_graph.concepts
  FOR EACH ROW
  EXECUTE FUNCTION concept_graph.touch_concept_updated_at();
