"""Retrieval tools: search / get_document / list_sources / list_documents.

Every query is scoped to collections the caller may see:
``owner = 'platform' OR owner = caller``. `source`/`source_type` are provenance
filters, applied on top. Search is the keyword path (substring match); vector +
LLM rerank is a later addition and an eval concern, not a contract one.
"""

from .db import get_pool
from .errors import NotFound

# Access predicate shared by every query; $1 is always the caller.
_ACCESS = "(c.owner = 'platform' OR c.owner = $1)"


async def search(caller, query, source=None, source_type=None, limit=5):
    pool = await get_pool()
    rows = await pool.fetch(
        f"""
        SELECT d.filename, d.source, d.source_type, d.content
        FROM documents d JOIN collections c ON c.id = d.collection_id
        WHERE {_ACCESS}
          AND (d.content ILIKE '%' || $2 || '%' OR d.filename ILIKE '%' || $2 || '%')
          AND ($3::text IS NULL OR d.source = $3)
          AND ($4::text IS NULL OR d.source_type = $4)
        ORDER BY d.filename
        LIMIT $5
        """,
        caller, query, source, source_type, limit,
    )
    if not rows:
        return "No results."
    return "\n\n".join(f"{r['source']}/{r['filename']}\n{r['content']}" for r in rows)


async def get_document(caller, filename, source=None, format="full"):
    pool = await get_pool()
    row = await pool.fetchrow(
        f"""
        SELECT d.filename, d.content
        FROM documents d JOIN collections c ON c.id = d.collection_id
        WHERE {_ACCESS} AND d.filename = $2 AND ($3::text IS NULL OR d.source = $3)
        LIMIT 1
        """,
        caller, filename, source,
    )
    if row is None:
        raise NotFound(f"document not found: {filename}")
    if format == "headings":
        headings = [
            line.lstrip("#").strip()
            for line in row["content"].splitlines()
            if line.lstrip().startswith("#")
        ]
        return "\n".join(headings) if headings else "(no headings)"
    return row["content"]


async def list_sources(caller, source_type=None):
    pool = await get_pool()
    rows = await pool.fetch(
        f"""
        SELECT d.source, count(*) AS n
        FROM documents d JOIN collections c ON c.id = d.collection_id
        WHERE {_ACCESS} AND ($2::text IS NULL OR d.source_type = $2)
        GROUP BY d.source ORDER BY d.source
        """,
        caller, source_type,
    )
    if not rows:
        return "No sources."
    return "\n".join(f"{r['source']} ({r['n']})" for r in rows)


async def list_documents(caller, source=None, source_type=None, limit=100):
    pool = await get_pool()
    rows = await pool.fetch(
        f"""
        SELECT d.source, d.filename
        FROM documents d JOIN collections c ON c.id = d.collection_id
        WHERE {_ACCESS}
          AND ($2::text IS NULL OR d.source = $2)
          AND ($3::text IS NULL OR d.source_type = $3)
        ORDER BY d.filename LIMIT $4
        """,
        caller, source, source_type, limit,
    )
    if not rows:
        return "No documents."
    return "\n".join(f"{r['source']}/{r['filename']}" for r in rows)
