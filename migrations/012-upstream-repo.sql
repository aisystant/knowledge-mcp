-- 012: upstream_repo for fork sync (WP-5 Ф12b)
--
-- Добавляет upstream_repo в user_sources — ссылка на оригинал форка
-- (e.g. "aisystant/DS-ecosystem-development").
-- Gateway при push в upstream находит все форки и синхронизирует их.
--
-- Run: psql $DATABASE_URL -f migrations/012-upstream-repo.sql

ALTER TABLE knowledge.user_sources ADD COLUMN IF NOT EXISTS upstream_repo TEXT;

CREATE INDEX IF NOT EXISTS idx_user_sources_upstream
  ON knowledge.user_sources(upstream_repo) WHERE upstream_repo IS NOT NULL;

-- Backfill: DS-ecosystem-development у Тсерена — форк aisystant
UPDATE knowledge.user_sources
SET upstream_repo = 'aisystant/DS-ecosystem-development'
WHERE source = 'DS-ecosystem-development'
  AND github_owner = 'TserenTserenov'
  AND upstream_repo IS NULL;
