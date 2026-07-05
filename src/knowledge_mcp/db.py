"""Postgres access: a per-event-loop asyncpg pool.

The schema is owned by versioned migrations (../migrations, applied with yoyo).
This module only connects — it never creates tables. The pool is cached per
running event loop (pytest gives each test its own loop, and an asyncpg pool is
bound to the loop it was created on).
"""

import asyncio

import asyncpg

from .config import database_url

_pools: dict[asyncio.AbstractEventLoop, asyncpg.Pool] = {}


async def get_pool() -> asyncpg.Pool:
    loop = asyncio.get_running_loop()
    pool = _pools.get(loop)
    if pool is None or pool._closed:  # noqa: SLF001 — asyncpg exposes no public "is closed"
        pool = await asyncpg.create_pool(dsn=database_url(), min_size=1, max_size=5)
        _pools[loop] = pool
    return pool
