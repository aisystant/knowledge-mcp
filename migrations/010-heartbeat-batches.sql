-- 010: Heartbeat + batch accounting for reindex_jobs (WP-187 Ф-K.1.2)
--
-- Context: Ф-K.1 (migration 009) использовал ctx.waitUntil для long-running reindex.
-- Cloudflare убивает waitUntil через ~30 сек grace period — 2 job'а застряли в 'running'
-- без heartbeat, без прогресса, без сигнала о eviction (см. WP-187-knowledge-gateway-mvp.md
-- "Ф-K.1 reverted").
--
-- Ф-K.1.2 переносит исполнение на Cloudflare Queues (ArchGate Variant A, пройден 18 апр).
-- Producer делит работу на batch'и по 10 файлов, queue consumer обрабатывает каждое
-- сообщение ≤30 сек, ack'ает и обновляет прогресс инкрементально. Для этого нужны
-- два новых поля:
--
-- * last_heartbeat_at — обновляется consumer'ом при каждом успешном ack. Watchdog cron
--   (~5 мин) помечает job 'failed', если running AND NOW() - last_heartbeat_at > 2 мин
--   AND completed_batches < expected_batches. Это и есть автоматический аналог того,
--   что 18 апр пришлось делать вручную через UPDATE.
--
-- * expected_batches / completed_batches — детерминированный критерий "всё сделано":
--   когда completed_batches = expected_batches → status='succeeded'. Нельзя полагаться
--   только на processed=total, т.к. msg.retry() при at-least-once может увеличить
--   processed выше total (дубликаты защищены ON CONFLICT DO NOTHING, но счётчик
--   инкрементирует на каждый ack).

ALTER TABLE knowledge.reindex_jobs
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expected_batches INT,
  ADD COLUMN IF NOT EXISTS completed_batches INT NOT NULL DEFAULT 0;

-- Watchdog (stale detection): раз в 5 мин SELECT running jobs с протухшим heartbeat.
CREATE INDEX IF NOT EXISTS idx_reindex_jobs_running_heartbeat
  ON knowledge.reindex_jobs (last_heartbeat_at)
  WHERE status = 'running';
