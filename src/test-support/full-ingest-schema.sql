-- Fixture for src/full-ingest.pg.test.ts: the shape of knowledge_chunk plus the WP-532 Ф9 tables.
--
-- Provenance (copy, not a source of truth): sections 011, 013, 014 and the unique index of 016 are
-- VERBATIM from neon-migrations/mvp/ in the DS-IT-systems repo (checked 2026-09-29); section 024 is
-- migrations/024-full-ingest-staging.sql of this repo. Two deliberate deviations, both because the
-- pgvector extension is not assumed on a developer machine:
--   * `vector` is a text-backed DOMAIN, so `'[..]'::vector` casts and `embedding vector` columns work;
--   * the hnsw index and `vector(1024)` typmods are dropped.
-- Everything else the swap relies on (NOT NULL chunk_id, kc_kind_consistency, the self-FK,
-- the generated tsvector, the trigram GIN, idx_kc_source_uri_source_account) is the real thing.
-- If the production schema changes, re-copy these sections; the rehearsal on a Neon branch
-- (see the F9 launch runbook) is what proves the real database still matches.
-- harness shim: pgvector is not installed on this host; a text-backed domain keeps '::vector' casts and column types valid
CREATE DOMAIN vector AS text;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ===== 011 (verbatim) =====
-- WP-268 Ф{N}: knowledge БД — личные коллекции пользователя (НЕ платформенные)
-- Источник: DP.ARCH.004 v2.2 §3.1 (Персона: COLLECTION/DOCUMENT/EMBEDDING) +
--          §3.7 (Знание-платформы — отдельная БД, для платформенного индекса)
-- Подключение: psql "${CONN%/*}/knowledge?sslmode=require"
--
-- ВАЖНО: согласно DP.ARCH.004 §3.7 namespace-инвариант — личные коллекции
-- (`personal.*`) живут отдельно от платформенных (`platform.*`). В этой
-- БД knowledge — личные коллекции пользователя (PACK-personal, DS-my-strategy,
-- personal-guide). Платформенные (PACK-digital-platform, MIM, SOTA, guides)
-- индексируются knowledge-mcp в отдельный namespace.
--
-- MVP-объём: 2 таблицы (personal_collection, knowledge_chunk).
-- Полный COLLECTION + DOCUMENT + PARAGRAPH + EMBEDDING (с pgvector) +
-- CONCEPT + RELATION (DP.ARCH.004 §3.1, §3.7) — наполняется отдельным child-WP
-- при подключении personal-indexer и pgvector extension.
--
-- Категория WP-257: Персона (личные коллекции). Маркер: О (Объект — каждая
-- коллекция = факт регистрации источника к индексации).
-- Writer: personal-indexer (читает Git-репо пользователя и эмбеддит) +
-- пользователь (регистрация source_uri через бот /index).
-- Owner: Neon (как проекция Git, rebuildable при reindex).

-- ============================================================
-- personal_collection — регистрация источника к индексации
-- Маркер: О (Объект). Пишет: пользователь (через бот/CLI),
-- personal-indexer обновляет indexed_at/status.
-- Читает: personal-indexer (next reindex), gateway-mcp (knowledge_search),
-- бот /sources.
-- Logical FK: account_id → persona.ory_identity (cross-DB).
-- ============================================================

CREATE TABLE personal_collection (
    collection_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      UUID NOT NULL,               -- logical FK to persona.ory_identity (cross-DB)
    source_kind     TEXT NOT NULL,               -- 'github' / 'notion' / 'manual'
    source_uri      TEXT NOT NULL,               -- 'github.com/TserenTserenov/personal-guide' / notion page url / manual:capture-stream
    namespace       TEXT NOT NULL,               -- 'personal.pack' / 'personal.strategy' / 'personal.guide' (см. DP.ARCH.004 §3.1)
    last_commit_sha TEXT,                        -- для github: последний проиндексированный commit
    indexed_at      TIMESTAMPTZ,                 -- nullable: NULL = ещё не индексирована
    status          TEXT NOT NULL DEFAULT 'pending', -- 'pending' / 'indexing' / 'ready' / 'failed' / 'archived'
    error_message   TEXT,                        -- для status='failed': последняя ошибка
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (source_kind IN ('github', 'notion', 'manual')),
    CHECK (status IN ('pending', 'indexing', 'ready', 'failed', 'archived')),
    UNIQUE (account_id, source_uri)              -- один пользователь не может зарегистрировать один и тот же источник дважды
);

CREATE INDEX idx_personal_collection_account_kind ON personal_collection (account_id, source_kind);
CREATE INDEX idx_personal_collection_indexed ON personal_collection (indexed_at DESC) WHERE status = 'ready';
CREATE INDEX idx_personal_collection_pending ON personal_collection (created_at) WHERE status = 'pending';

COMMENT ON TABLE personal_collection IS 'Регистрация личного источника знаний к индексации (О). namespace инвариант DP.ARCH.004 §3.7: только `personal.*` (платформенные `platform.*` — отдельная БД knowledge-platform). Logical FK: account_id → persona.ory_identity (cross-DB).';
COMMENT ON COLUMN personal_collection.namespace IS 'Префикс personal.* — отделяет личные коллекции от платформенных. Канонические: personal.pack (PACK-personal), personal.strategy (DS-my-strategy), personal.guide (personal-guide).';
COMMENT ON COLUMN personal_collection.source_uri IS 'Identifier источника. Для github: полный URL `github.com/<owner>/<repo>` (без protocol). Для notion: shareable page URL. Для manual: `manual:<stream-name>` (например `manual:captures`).';

-- ============================================================
-- knowledge_chunk — фрагменты содержания (paragraph + embedding ref)
-- Маркер: О (Объект — каждый chunk = индексированный фрагмент).
-- Пишет: personal-indexer (батч при reindex). UPSERT по (collection_id, chunk_id).
-- Читает: gateway-mcp (knowledge_search → retrieval).
-- ============================================================

CREATE TABLE knowledge_chunk (
    chunk_uuid      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    collection_id   UUID NOT NULL REFERENCES personal_collection (collection_id),
    chunk_id        TEXT NOT NULL,               -- стабильный id фрагмента в источнике (path:paragraph_index)
    document_path   TEXT NOT NULL,               -- путь файла в репо ('pack/.../DP.ARCH.004.md', 'memory/MEMORY.md')
    paragraph_pos   INTEGER NOT NULL,            -- позиция параграфа в документе (для reconstruction context)
    content_hash    TEXT NOT NULL,               -- хеш содержания для detect-changes-on-reindex
    content_preview TEXT,                        -- первые 200 символов для debug (полный текст — в embedding store)
    embedding_id    TEXT,                        -- id вектора во внешнем store (pgvector / dedicated vector DB) — добавлять при подключении pgvector
    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (collection_id, chunk_id)             -- стабильность chunk_id для idempotent reindex
);

CREATE INDEX idx_knowledge_chunk_collection ON knowledge_chunk (collection_id, indexed_at DESC);
CREATE INDEX idx_knowledge_chunk_document ON knowledge_chunk (collection_id, document_path);
CREATE INDEX idx_knowledge_chunk_hash ON knowledge_chunk (content_hash);

COMMENT ON TABLE knowledge_chunk IS 'Индексированные фрагменты личных коллекций (О). Стабильный chunk_id (collection-relative path:position) делает reindex idempotent: при изменении content_hash — UPDATE existing row, не дубль. Сами вектора в отдельном store (pgvector / dedicated) — здесь только метаданные + embedding_id для JOIN.';
COMMENT ON COLUMN knowledge_chunk.embedding_id IS 'Id вектора во внешнем store. При активации pgvector — заменить на колонку embedding VECTOR(1536) inline. В MVP — text-ссылка (для гибкости миграции на dedicated vector DB).';
COMMENT ON COLUMN knowledge_chunk.content_preview IS 'Первые ~200 символов параграфа для debug knowledge_search results. Полный текст не дублируется (источник истины — Git-репо пользователя). Класс данных: следует классу источника (PACK-personal, DS-my-strategy могут содержать PII в captures — gateway-mcp фильтрует на уровне retrieval).';

-- ============================================================
-- Verify (запустить вручную после миграции)
-- ============================================================
-- SELECT 'personal_collection' AS tbl, COUNT(*) AS rows FROM personal_collection
-- UNION ALL SELECT 'knowledge_chunk', COUNT(*) FROM knowledge_chunk;
-- Expected: обе таблицы = 0 (заполняются personal-indexer'ом после регистрации
-- первого source_uri пользователем через бот /index).

-- ===== 013 (vector shimmed) =====
-- WP-268 Phase 2 cut-over: knowledge_chunk DDL extension для bulk-миграции
-- 16 809 docs из neondb.documents (legacy knowledge-mcp, 497 MB) в knowledge.knowledge_chunk.
--
-- Расширение MVP-схемы (011-knowledge-schema.sql) для поддержки:
--   1. Платформенный (НЕ персональный) контент (12 331 docs, user_id IS NULL)
--   2. Реальный embedding inline через pgvector (1024-dim, не 1536 — verified в legacy)
--   3. Полнотекст (FTS) реплицирует поведение neondb.documents.search_vector
--   4. Self-FK parent_id (4 947 docs имеют родителя — например, разбиение по параграфам)
--   5. Traceability через legacy_id для idempotent ETL (ON CONFLICT)
--
-- Решение: collection_kind ENUM ('personal', 'platform').
--   personal → account_id NOT NULL, collection_id NOT NULL (как в MVP)
--   platform → account_id NULL,    collection_id NULL    (общеплатформенный контент)
--
-- pgvector 0.8.0 доступен в Neon (verified через pg_available_extensions).
-- Runtime apply: psql "$KNOWLEDGE_DIRECT" -v ON_ERROR_STOP=1 -f mvp/013-knowledge-platform-extension.sql

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- 1. Extensions
-- ─────────────────────────────────────────────────────────────

-- (shim) CREATE EXTENSION vector skipped          -- pgvector inline embeddings
CREATE EXTENSION IF NOT EXISTS pg_trgm;         -- gin_trgm_ops (как в legacy idx_documents_trgm)

-- ─────────────────────────────────────────────────────────────
-- 2. knowledge_chunk: расширение для platform docs + embedding inline
-- ─────────────────────────────────────────────────────────────

-- 2.1 Тип коллекции (personal vs platform)
ALTER TABLE knowledge_chunk
  ADD COLUMN IF NOT EXISTS collection_kind TEXT NOT NULL DEFAULT 'personal'
    CHECK (collection_kind IN ('personal', 'platform'));

-- 2.2 Account/collection nullable для platform docs
--   collection_id уже NOT NULL в MVP (FK на personal_collection) — снимаем NN
--   FK сохраняем как deferrable: NULL обходит проверку
ALTER TABLE knowledge_chunk
  ALTER COLUMN collection_id DROP NOT NULL;

-- (account_id колонка отсутствовала в MVP knowledge_chunk — добавляем)
ALTER TABLE knowledge_chunk
  ADD COLUMN IF NOT EXISTS account_id UUID;

-- 2.3 Legacy meta + контент + embedding inline
ALTER TABLE knowledge_chunk
  ADD COLUMN IF NOT EXISTS legacy_id    BIGINT,
  ADD COLUMN IF NOT EXISTS source_kind  TEXT,           -- 'ds'/'guides'/'pack'/'content' (legacy source_type)
  ADD COLUMN IF NOT EXISTS source_uri   TEXT,           -- legacy filename
  ADD COLUMN IF NOT EXISTS source       TEXT,           -- legacy source (часто пусто)
  ADD COLUMN IF NOT EXISTS content      TEXT,           -- raw contents
  ADD COLUMN IF NOT EXISTS embedding    vector,   -- pgvector inline 1024-dim
  ADD COLUMN IF NOT EXISTS hash         CHAR(16),       -- legacy hash для dedup
  ADD COLUMN IF NOT EXISTS parent_legacy_id BIGINT,     -- self-FK на documents.parent_id (legacy id)
  ADD COLUMN IF NOT EXISTS legacy_created_at TIMESTAMPTZ;  -- сохранить created_at из legacy

-- 2.4 Уникальность legacy_id (для ON CONFLICT ETL)
CREATE UNIQUE INDEX IF NOT EXISTS uq_kc_legacy_id ON knowledge_chunk (legacy_id) WHERE legacy_id IS NOT NULL;

-- 2.5 Согласованность: для personal — account_id обязателен; для platform — оба NULL
--   Реализовано через триггер (CHECK не работает с условием на других колонках в MVP-стиле).
--   В MVP — упрощённо через CHECK без вложенности:
ALTER TABLE knowledge_chunk
  ADD CONSTRAINT kc_kind_consistency CHECK (
    (collection_kind = 'personal'  AND account_id IS NOT NULL) OR
    (collection_kind = 'platform' AND account_id IS NULL AND collection_id IS NULL)
  );

-- ─────────────────────────────────────────────────────────────
-- 3. Полнотекстовый поиск (FTS) — реплика neondb.documents
-- ─────────────────────────────────────────────────────────────

ALTER TABLE knowledge_chunk
  ADD COLUMN IF NOT EXISTS search_vector TSVECTOR
    GENERATED ALWAYS AS (to_tsvector('russian', coalesce(content, ''))) STORED;

-- ─────────────────────────────────────────────────────────────
-- 4. Индексы (retrieval pattern из legacy)
-- ─────────────────────────────────────────────────────────────

-- pgvector HNSW для cosine similarity (legacy: idx_documents_embedding)
-- (shim) hnsw index skipped

-- FTS (legacy: idx_documents_fts)
CREATE INDEX IF NOT EXISTS idx_kc_fts
  ON knowledge_chunk USING gin (search_vector);

-- Trigram (legacy: idx_documents_trgm)
CREATE INDEX IF NOT EXISTS idx_kc_trgm
  ON knowledge_chunk USING gin (content gin_trgm_ops);

-- Source filtering
CREATE INDEX IF NOT EXISTS idx_kc_source_kind
  ON knowledge_chunk (source_kind, collection_kind);

CREATE INDEX IF NOT EXISTS idx_kc_collection_kind
  ON knowledge_chunk (collection_kind);

-- Personal isolation (legacy: idx_documents_user_id)
CREATE INDEX IF NOT EXISTS idx_kc_account_personal
  ON knowledge_chunk (account_id) WHERE collection_kind = 'personal';

-- Parent traversal (legacy: idx_documents_parent_id)
CREATE INDEX IF NOT EXISTS idx_kc_parent_legacy_id
  ON knowledge_chunk (parent_legacy_id) WHERE parent_legacy_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- 5. Comments
-- ─────────────────────────────────────────────────────────────

COMMENT ON COLUMN knowledge_chunk.collection_kind IS
  'personal = частная коллекция (account_id обязателен, collection_id ссылается на personal_collection); platform = общеплатформенный контент (account_id и collection_id NULL).';
COMMENT ON COLUMN knowledge_chunk.embedding IS
  'pgvector 1024-dim. Source: legacy knowledge-mcp pipeline (модель эмбеддера не подтверждена — см. ArchGate decision 27 апр).';
COMMENT ON COLUMN knowledge_chunk.legacy_id IS
  'Ссылка на neondb.documents.id для traceability ETL и idempotent ON CONFLICT.';
COMMENT ON COLUMN knowledge_chunk.parent_legacy_id IS
  'Legacy self-FK: ссылается на neondb.documents.id родителя. После ETL можно резолвить через JOIN на legacy_id для построения parent_chunk_uuid.';
COMMENT ON COLUMN knowledge_chunk.source_kind IS
  'Категория источника: ds/guides/pack/content (legacy source_type).';
COMMENT ON COLUMN knowledge_chunk.account_id IS
  'Personal docs: UUID владельца (logical FK → persona.ory_identity). Platform docs: NULL.';

COMMIT;

-- ===== 014 (verbatim) =====
-- WP-268 Phase 2 cut-over (D): построение self-FK parent_chunk_id (UUID) на knowledge_chunk
--
-- Контекст: legacy `neondb.documents.parent_id` (BIGINT) → новая `knowledge_chunk.parent_chunk_id` (UUID).
-- Bulk ETL (26 апр) сохранил legacy parent FK через `parent_legacy_id` (BIGINT shim).
-- Этот скрипт строит UUID-self-FK на основе legacy_id JOIN. После apply
-- knowledge-mcp использует `parent_chunk_id` (быстро) и держит `parent_legacy_id` как fallback.
--
-- Apply: psql "$KNOWLEDGE_DIRECT" -v ON_ERROR_STOP=1 -f mvp/014-knowledge-parent-fk-build.sql
-- Idempotent: ALTER ... IF NOT EXISTS + UPDATE WHERE NULL.

BEGIN;

-- 1. Добавить колонку parent_chunk_id (UUID self-FK на chunk_uuid PK)
ALTER TABLE knowledge_chunk
  ADD COLUMN IF NOT EXISTS parent_chunk_id UUID
    REFERENCES knowledge_chunk (chunk_uuid) ON DELETE SET NULL;

-- 2. Резолв через JOIN на legacy_id (4 947 docs имеют родителя)
UPDATE knowledge_chunk c
SET parent_chunk_id = p.chunk_uuid
FROM knowledge_chunk p
WHERE c.parent_legacy_id IS NOT NULL
  AND c.parent_chunk_id IS NULL
  AND p.legacy_id = c.parent_legacy_id;

-- 3. Индекс для JOIN performance (used by enrichWithParentContent)
CREATE INDEX IF NOT EXISTS idx_kc_parent_chunk_id
  ON knowledge_chunk (parent_chunk_id) WHERE parent_chunk_id IS NOT NULL;

-- 4. Verify (запускается отдельно после COMMIT)
-- SELECT
--   COUNT(*) FILTER (WHERE parent_legacy_id IS NOT NULL) AS legacy_parents,
--   COUNT(*) FILTER (WHERE parent_chunk_id IS NOT NULL) AS uuid_parents,
--   COUNT(*) FILTER (WHERE parent_legacy_id IS NOT NULL AND parent_chunk_id IS NULL) AS unresolved
-- FROM knowledge_chunk;
-- Expected: legacy_parents = uuid_parents (4 947), unresolved = 0.

COMMIT;

-- ===== 016 lines 88-93 (unique index used by ON CONFLICT and by the swap) =====
CREATE UNIQUE INDEX IF NOT EXISTS idx_kc_source_uri_source_account
  ON knowledge_chunk (
    source_uri,
    source,
    COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- ===== 024 (vector shimmed) =====
-- 024: Batched full-ingest for oversized platform documents (WP-532 Ф9)
--
-- syncFullIngestSource() (migration 015 context) chunks and embeds a document
-- sequentially, one chunk at a time, deleting the old chunks first. For a document
-- the size of FPF-Spec.md (~1500 chunks) that risks leaving the document's search
-- rows in a genuinely incomplete state if the run doesn't finish. This migration adds
-- the two tables a batched, resumable, atomically-swapped version needs:
--
--   full_ingest_runs      — one row per full-ingest attempt of one document. The
--                            partial unique index below is the actual single-writer
--                            enforcement (DB-level, not application discipline) — a
--                            second concurrent run for the same document simply
--                            cannot insert a 'running' row.
--   knowledge_chunk_staging — chunks land here, batch by batch, invisible to search
--                            (a different table, not a flag on knowledge_chunk — a
--                            flag would need every search query path to filter on
--                            it, a broader change against code every source relies
--                            on). Moved into knowledge_chunk only once every chunk is
--                            confirmed present, via the CAS pattern the consumer code
--                            implements against full_ingest_runs.status.
--
-- Apply: psql "$KNOWLEDGE_DIRECT" -v ON_ERROR_STOP=1 -f migrations/024-full-ingest-staging.sql

BEGIN;

CREATE TABLE IF NOT EXISTS full_ingest_runs (
  run_id          TEXT PRIMARY KEY,
  source          TEXT NOT NULL,
  document_path   TEXT NOT NULL,
  source_revision TEXT NOT NULL,  -- GitHub blob SHA pinned before batching starts
  total_chunks    INT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'swapping', 'swapped', 'abandoned')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  swapped_at      TIMESTAMPTZ
);

-- The actual single-writer guarantee: a second INSERT for the same (source,
-- document_path) while one run is still 'running' violates this index and fails,
-- not a race an application-level check could lose.
CREATE UNIQUE INDEX IF NOT EXISTS uq_running_ingest_per_doc
  ON full_ingest_runs (source, document_path)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_full_ingest_runs_created_at
  ON full_ingest_runs (created_at)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS knowledge_chunk_staging (
  staging_id        BIGSERIAL PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES full_ingest_runs (run_id) ON DELETE CASCADE,
  chunk_index       INT NOT NULL CHECK (chunk_index >= 0),
  role              TEXT NOT NULL CHECK (role IN ('parent', 'child')),
  -- knowledge_chunk.chunk_uuid is PK DEFAULT gen_random_uuid() — fine for a single-row
  -- insert, but the final swap moves parent+children in one INSERT...SELECT, and a
  -- child row's parent_chunk_id must point at ITS PARENT'S uuid. A value only Postgres
  -- assigns at that same INSERT can't be read back into a sibling row of the same
  -- statement. Generating both uuids client-side before staging (and carrying them
  -- through) sidesteps the self-reference instead of a second UPDATE pass after insert.
  chunk_uuid        UUID NOT NULL,
  parent_chunk_uuid  UUID,  -- NULL for role='parent'; the parent's own chunk_uuid for role='child'
  chunk_id          TEXT NOT NULL,
  document_path     TEXT NOT NULL,
  paragraph_pos     INT NOT NULL,
  content_hash      TEXT NOT NULL,
  source_uri        TEXT NOT NULL,
  content           TEXT NOT NULL,
  source            TEXT NOT NULL,
  source_kind       TEXT,
  hash              CHAR(16) NOT NULL,
  embedding         vector,  -- NULL for the parent row, matching knowledge_chunk's own large-file convention
  collection_kind   TEXT NOT NULL DEFAULT 'platform',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_kcs_run_id ON knowledge_chunk_staging (run_id);

COMMENT ON TABLE full_ingest_runs IS
  'WP-532 Ф9: one row per batched full-ingest attempt. status=running is the DB-enforced single-writer claim (uq_running_ingest_per_doc); swapping is the CAS state a consumer holds while performing the atomic cutover; abandoned = source changed mid-run or run exceeded its TTL, cleaned up by the next scheduled sweep.';
COMMENT ON TABLE knowledge_chunk_staging IS
  'WP-532 Ф9: draft chunks for an in-progress full-ingest run, invisible to search (separate table, not a flag on knowledge_chunk). Moved into knowledge_chunk in one transaction once every chunk_index for the run is present.';

COMMIT;
