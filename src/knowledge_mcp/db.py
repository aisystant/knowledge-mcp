"""Postgres access: a per-event-loop asyncpg pool and one-time schema bootstrap.

The pool is cached per running event loop (pytest gives each test its own loop,
and an asyncpg pool is bound to the loop it was created on).
"""

import asyncio

import asyncpg

from .config import database_url

_pools: dict[asyncio.AbstractEventLoop, asyncpg.Pool] = {}

SCHEMA_SQL = """
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Access unit. Exactly one owner per collection; 'platform' is the public owner.
CREATE TABLE IF NOT EXISTS collections (
  id     BIGSERIAL PRIMARY KEY,
  name   TEXT UNIQUE NOT NULL,
  owner  TEXT NOT NULL
);

-- Retrieval corpus. `source`/`source_type` are provenance (search filter),
-- orthogonal to access, which is governed by the owning collection.
CREATE TABLE IF NOT EXISTS documents (
  id            BIGSERIAL PRIMARY KEY,
  collection_id BIGINT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT '',
  source_type   TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL,
  embedding     vector(1024),
  UNIQUE (collection_id, filename)
);
CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection_id);
CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source);
CREATE INDEX IF NOT EXISTS idx_documents_content_trgm ON documents USING gin (content gin_trgm_ops);

-- Graph nodes: concepts AND artifacts, discriminated by node_type.
CREATE TABLE IF NOT EXISTS concepts (
  id            BIGSERIAL PRIMARY KEY,
  collection_id BIGINT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  node_type     TEXT NOT NULL DEFAULT 'concept',
  status        TEXT NOT NULL DEFAULT 'active',
  superseded_by TEXT,
  misconception BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (collection_id, code)
);
CREATE INDEX IF NOT EXISTS idx_concepts_collection ON concepts(collection_id);
CREATE INDEX IF NOT EXISTS idx_concepts_name_trgm ON concepts USING gin (name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS concept_edges (
  id            BIGSERIAL PRIMARY KEY,
  collection_id BIGINT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  from_code     TEXT NOT NULL,
  to_code       TEXT NOT NULL,
  edge_type     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edges_collection_from
  ON concept_edges(collection_id, from_code, edge_type);
"""


async def get_pool() -> asyncpg.Pool:
    loop = asyncio.get_running_loop()
    pool = _pools.get(loop)
    if pool is None or pool._closed:  # noqa: SLF001 — asyncpg exposes no public "is closed"
        pool = await asyncpg.create_pool(dsn=database_url(), min_size=1, max_size=5)
        async with pool.acquire() as con:
            await con.execute(SCHEMA_SQL)
        _pools[loop] = pool
    return pool
