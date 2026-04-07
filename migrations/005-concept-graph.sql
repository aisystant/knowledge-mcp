-- WP-208: Concept Graph — граф понятий платформы
-- Отдельная schema "concept_graph" в той же Neon DB что и public.documents
-- АрхГейт: вариант B (schema isolation). Cross-schema FK на public.documents.
-- ВАЖНО: при pooled connections использовать явные квалификаторы,
--         НЕ SET search_path в runtime.

CREATE SCHEMA IF NOT EXISTS concept_graph;

-- ============================================================
-- Узлы графа: понятия из ZP, FPF, Pack, руководств, программ
-- ============================================================
CREATE TABLE IF NOT EXISTS concept_graph.concepts (
  id BIGSERIAL PRIMARY KEY,

  -- Идентификация
  code TEXT UNIQUE,                    -- entity code: "ZP.1", "MIM.FMT.001", "U.Method"
  name TEXT NOT NULL,                  -- "Аксиоматичность", "Семинар", "Волевое усилие"
  definition TEXT,                     -- каноническое определение (из Pack/ZP/FPF)

  -- Иерархия знаний
  level TEXT NOT NULL CHECK (level IN ('zp', 'fpf', 'pack', 'guide', 'course')),
  domain TEXT,                         -- "MIM", "DP", "PD", "ECO", null для ZP/FPF

  -- Источник
  source_doc TEXT,                     -- filename в documents: "pack/mim/03-methods/MIM.M.006.md"
  source_repo TEXT,                    -- "PACK-MIM", "FPF", "ZP", "docs-courses"
  document_id BIGINT REFERENCES public.documents(id) ON DELETE SET NULL,

  -- Эмбединг (тот же формат что documents: 1024d)
  embedding vector(1024),

  -- Мета
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'draft')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Быстрый поиск по коду и имени
CREATE INDEX IF NOT EXISTS idx_concepts_code ON concept_graph.concepts(code);
CREATE INDEX IF NOT EXISTS idx_concepts_level ON concept_graph.concepts(level);
CREATE INDEX IF NOT EXISTS idx_concepts_domain ON concept_graph.concepts(domain);
CREATE INDEX IF NOT EXISTS idx_concepts_name_trgm ON concept_graph.concepts USING gin(name gin_trgm_ops);

-- Векторный поиск по понятиям
CREATE INDEX IF NOT EXISTS idx_concepts_embedding
  ON concept_graph.concepts USING hnsw (embedding vector_cosine_ops);

-- ============================================================
-- Рёбра графа: взвешенные связи между понятиями
-- ============================================================
CREATE TABLE IF NOT EXISTS concept_graph.concept_edges (
  id BIGSERIAL PRIMARY KEY,
  from_concept_id BIGINT NOT NULL REFERENCES concept_graph.concepts(id) ON DELETE CASCADE,
  to_concept_id BIGINT NOT NULL REFERENCES concept_graph.concepts(id) ON DELETE CASCADE,

  -- Тип связи
  edge_type TEXT NOT NULL CHECK (edge_type IN (
    'prerequisite',   -- A нужно знать до B
    'related',        -- A и B связаны (симметрично)
    'part_of',        -- A часть B (холон)
    'specializes',    -- A конкретизирует B
    'contradicts'     -- A противоречит B (для мемов)
  )),

  -- Вес связи (0.0 — 1.0)
  weight REAL NOT NULL DEFAULT 0.5 CHECK (weight >= 0 AND weight <= 1),

  -- Как вычислен вес
  weight_source TEXT NOT NULL DEFAULT 'llm' CHECK (weight_source IN (
    'manual',         -- эксперт задал
    'llm',            -- LLM определил
    'pmi',            -- PMI из ко-вхождений
    'embedding',      -- cosine similarity эмбедингов
    'computed'        -- агрегат нескольких методов
  )),

  -- Мета
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Уникальность: одна связь данного типа между парой
  UNIQUE(from_concept_id, to_concept_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_edges_from ON concept_graph.concept_edges(from_concept_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON concept_graph.concept_edges(to_concept_id);
CREATE INDEX IF NOT EXISTS idx_edges_type ON concept_graph.concept_edges(edge_type);

-- ============================================================
-- Мемы: каталог типичных подмен и заблуждений
-- ============================================================
CREATE TABLE IF NOT EXISTS concept_graph.concept_misconceptions (
  id BIGSERIAL PRIMARY KEY,
  concept_id BIGINT NOT NULL REFERENCES concept_graph.concepts(id) ON DELETE CASCADE,

  -- Категория мема
  category TEXT NOT NULL CHECK (category IN (
    'wrong_concept',        -- применяет понятие A где нужно B
    'wrong_application',    -- знает термин, ошибается в использовании
    'folk_substitution'     -- бытовая подмена ("сила воли" вместо "волевое усилие")
  )),

  -- Описание
  misconception_text TEXT NOT NULL,    -- что говорит/пишет ученик
  correct_version TEXT,                -- как правильно
  folk_term TEXT,                      -- бытовой термин (для folk_substitution)

  -- Источник: из DS-principles-curriculum/data/curriculum/CAT.001/
  source_file TEXT,                    -- "M-001-i-already-know.md"

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_misconceptions_concept ON concept_graph.concept_misconceptions(concept_id);
CREATE INDEX IF NOT EXISTS idx_misconceptions_category ON concept_graph.concept_misconceptions(category);

-- ============================================================
-- Learner model: покрытие понятий на ученика
-- ============================================================
CREATE TABLE IF NOT EXISTS concept_graph.learner_concept_mastery (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,               -- Ory identity UUID
  concept_id BIGINT NOT NULL REFERENCES concept_graph.concepts(id) ON DELETE CASCADE,

  -- Байесовская оценка мастерства (0.0 — 1.0)
  mastery REAL NOT NULL DEFAULT 0.0 CHECK (mastery >= 0 AND mastery <= 1),

  -- Статистика
  attempts INT NOT NULL DEFAULT 0,
  last_score REAL,                     -- последний балл (0.0 — 1.0)
  last_assessed_at TIMESTAMPTZ,

  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, concept_id)
);

CREATE INDEX IF NOT EXISTS idx_mastery_user ON concept_graph.learner_concept_mastery(user_id);
CREATE INDEX IF NOT EXISTS idx_mastery_concept ON concept_graph.learner_concept_mastery(concept_id);
