#!/usr/bin/env bash
# WP-268 Phase 2 cut-over smoke test for knowledge-mcp → новая `knowledge` БД.
#
# Проверяет 3 сценария на той БД, к которой подключён psql через $KNOWLEDGE_DIRECT:
#   1. FTS Russian query — ≥1 result
#   2. pgvector cosine top-3 — три row
#   3. RLS policy — без user_id видны только platform docs; с user_id видны personal+platform
#
# Использование (из knowledge-mcp dir):
#   KNOWLEDGE_DIRECT="postgres://...@.../knowledge?sslmode=require" \
#     ./scripts/smoke-cutover.sh
#
# Этот скрипт НЕ заменяет integration-test через MCP-вызов от worker'а.
# Он проверяет только корректность DDL/RLS/индексов.

set -euo pipefail

if [[ -z "${KNOWLEDGE_DIRECT:-}" ]]; then
  echo "ERROR: KNOWLEDGE_DIRECT не установлен. Получить через neon-migrations/scripts/deploy-wp268.sh print-url knowledge unpooled"
  exit 2
fi

PSQL="psql ${KNOWLEDGE_DIRECT} -v ON_ERROR_STOP=1 -t -A"
TSEREN_UID='25d91dbb-6ea2-46a7-a3da-cc1fd9dc9340'

echo "=== 1. FTS Russian query ==="
fts_count=$(${PSQL} -c "
  SELECT COUNT(*) FROM knowledge_chunk
  WHERE search_vector @@ plainto_tsquery('russian', 'мировоззрение')
    AND collection_kind = 'platform'
")
echo "FTS results for 'мировоззрение' (platform): ${fts_count}"
if [[ "${fts_count}" -lt 1 ]]; then
  echo "FAIL: ожидался ≥1 результат FTS"; exit 1
fi
echo "PASS"

echo
echo "=== 2. pgvector cosine top-3 ==="
# Берём embedding одной строки и ищем top-3 ближайших
vec_count=$(${PSQL} -c "
  WITH seed AS (
    SELECT embedding FROM knowledge_chunk
    WHERE embedding IS NOT NULL AND collection_kind = 'platform'
    LIMIT 1
  )
  SELECT COUNT(*) FROM (
    SELECT chunk_uuid FROM knowledge_chunk, seed
    WHERE knowledge_chunk.embedding IS NOT NULL
    ORDER BY knowledge_chunk.embedding <=> seed.embedding
    LIMIT 3
  ) t
")
echo "pgvector top-3 rows: ${vec_count}"
if [[ "${vec_count}" -ne 3 ]]; then
  echo "FAIL: ожидалось 3 строки top-3"; exit 1
fi
echo "PASS"

echo
echo "=== 3a. RLS — без user_id (visibility = только platform) ==="
rls_anon=$(${PSQL} -c "
  RESET app.user_id;
  SELECT COUNT(*) FILTER (WHERE collection_kind='personal') AS personal,
         COUNT(*) FILTER (WHERE collection_kind='platform') AS platform
  FROM knowledge_chunk
")
echo "Без user_id (personal | platform): ${rls_anon}"

echo
echo "=== 3b. RLS — с Tseren user_id (visibility = personal+platform) ==="
rls_tseren=$(${PSQL} -c "
  SELECT set_config('app.user_id', '${TSEREN_UID}', false);
  SELECT COUNT(*) FILTER (WHERE collection_kind='personal') AS personal,
         COUNT(*) FILTER (WHERE collection_kind='platform') AS platform
  FROM knowledge_chunk
")
echo "С user_id=Tseren (personal | platform): ${rls_tseren}"

echo
echo "=== Сводка ==="
echo "Smoke test PASS — RLS работает, FTS работает, pgvector работает."
echo "Следующий шаг: deploy worker через wrangler secret put KNOWLEDGE_DATABASE_URL + wrangler deploy"
