"""Ingestion: a Postgres-backed queue plus a worker that writes into the tables
the MCP server reads.

The producer (`enqueue`) is dumb about queue mechanics but owns change-detection:
it hashes each document, skips ones already indexed unchanged, and upserts the
rest into `ingest_jobs` keyed by (collection, filename) -- so a re-submit before
the queue drains never duplicates. The worker (`process_pending`) claims pending
jobs with FOR UPDATE SKIP LOCKED, runs `_extract` (chunk + embed via an injectable
embedder), and writes documents + chunks idempotently.

Embeddings are behind an injectable seam: a real embedder (OpenAI) in prod, and
None in tests (chunks are stored without vectors -- keyword search still works).
"""

import hashlib

from .db import get_pool

_CHUNK_SIZE = 2000
_CHUNK_OVERLAP = 200


def _hash(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()


def _chunk(content: str) -> list[str]:
    text = content.strip()
    if not text:
        return []
    if len(text) <= _CHUNK_SIZE:
        return [text]
    chunks, start = [], 0
    while start < len(text):
        chunks.append(text[start : start + _CHUNK_SIZE])
        start += _CHUNK_SIZE - _CHUNK_OVERLAP
    return chunks


async def enqueue(collection, owner, documents):
    """Submit raw documents. Skips ones already indexed unchanged; upserts the
    rest as pending jobs keyed by (collection, filename)."""
    pool = await get_pool()
    enqueued = skipped = 0
    async with pool.acquire() as con:
        for d in documents:
            digest = _hash(d["content"])
            indexed = await con.fetchval(
                """
                SELECT dm.content_hash FROM documents dm
                JOIN collections c ON c.id = dm.collection_id
                WHERE c.name = $1 AND dm.filename = $2
                """,
                collection, d["path"],
            )
            if indexed is not None and indexed == digest:
                skipped += 1
                continue
            await con.execute(
                """
                INSERT INTO ingest_jobs
                    (collection, owner, source, source_type, filename, content, content_hash)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (collection, filename) WHERE status = 'pending'
                DO UPDATE SET owner = EXCLUDED.owner, source = EXCLUDED.source,
                    source_type = EXCLUDED.source_type, content = EXCLUDED.content,
                    content_hash = EXCLUDED.content_hash, updated_at = now()
                """,
                collection, owner, d.get("source", ""), d.get("source_type", ""),
                d["path"], d["content"], digest,
            )
            enqueued += 1
    return {"enqueued": enqueued, "skipped": skipped}


async def pending_count(collection) -> int:
    pool = await get_pool()
    return await pool.fetchval(
        "SELECT count(*) FROM ingest_jobs WHERE collection = $1 AND status = 'pending'",
        collection,
    )


async def process_pending(embedder=None):
    """Drain all pending jobs. Each is claimed with SKIP LOCKED, extracted, and
    written; failures are recorded and the worker moves on."""
    pool = await get_pool()
    processed = failed = 0
    while True:
        async with pool.acquire() as con, con.transaction():
            job = await con.fetchrow(
                """
                SELECT * FROM ingest_jobs WHERE status = 'pending'
                ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
                """
            )
            if job is None:
                break
            try:
                await _extract(con, job, embedder)
                await con.execute(
                    "UPDATE ingest_jobs SET status = 'done', updated_at = now() WHERE id = $1",
                    job["id"],
                )
                processed += 1
            except Exception as exc:
                await con.execute(
                    """
                    UPDATE ingest_jobs SET status = 'failed', attempts = attempts + 1,
                        error = $2, updated_at = now() WHERE id = $1
                    """,
                    job["id"], str(exc),
                )
                failed += 1
    return {"processed": processed, "failed": failed}


async def _extract(con, job, embedder):
    cid = await con.fetchval(
        """
        INSERT INTO collections (name, owner) VALUES ($1, $2)
        ON CONFLICT (name) DO UPDATE SET owner = EXCLUDED.owner RETURNING id
        """,
        job["collection"], job["owner"],
    )
    doc_id = await con.fetchval(
        """
        INSERT INTO documents (collection_id, filename, source, source_type, content, content_hash)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (collection_id, filename) DO UPDATE SET
            source = EXCLUDED.source, source_type = EXCLUDED.source_type,
            content = EXCLUDED.content, content_hash = EXCLUDED.content_hash
        RETURNING id
        """,
        cid, job["filename"], job["source"], job["source_type"],
        job["content"], job["content_hash"],
    )
    await con.execute("DELETE FROM document_chunks WHERE document_id = $1", doc_id)
    chunks = _chunk(job["content"])
    embeddings = await embedder(chunks) if embedder else [None] * len(chunks)
    for i, (chunk, emb) in enumerate(zip(chunks, embeddings, strict=True)):
        if emb is None:
            await con.execute(
                "INSERT INTO document_chunks (document_id, position, content) VALUES ($1, $2, $3)",
                doc_id, i, chunk,
            )
        else:
            await con.execute(
                "INSERT INTO document_chunks (document_id, position, content, embedding) "
                "VALUES ($1, $2, $3, $4::vector)",
                doc_id, i, chunk, "[" + ",".join(str(x) for x in emb) + "]",
            )
