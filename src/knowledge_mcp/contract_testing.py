"""Test-only seams the contract harness drives (never used in production).

  * `seed(...)` writes one collection (with its owner) plus documents / concepts
    / edges through the same pool the app reads.
  * `authed_app()` builds the server in authed mode wired to a throwaway signing
    key, and returns `(app, mint)` where `mint(user_id)` issues a token the
    server accepts.
"""

import secrets
import time

from .app import create_app
from .auth import jwt_encode, make_hs256_verifier
from .config import PLATFORM
from .db import get_pool


async def seed(collection, owner=PLATFORM, documents=None, concepts=None, edges=None):
    pool = await get_pool()
    async with pool.acquire() as con:
        cid = await con.fetchval(
            """
            INSERT INTO collections (name, owner) VALUES ($1, $2)
            ON CONFLICT (name) DO UPDATE SET owner = EXCLUDED.owner
            RETURNING id
            """,
            collection, owner,
        )
        for d in documents or []:
            await con.execute(
                """
                INSERT INTO documents (collection_id, filename, source, source_type, content)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (collection_id, filename) DO UPDATE SET
                    source = EXCLUDED.source, source_type = EXCLUDED.source_type,
                    content = EXCLUDED.content
                """,
                cid, d["path"], d.get("source", ""), d.get("source_type", ""), d["content"],
            )
        for c in concepts or []:
            await con.execute(
                """
                INSERT INTO concepts
                    (collection_id, code, name, node_type, status, superseded_by, misconception)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (collection_id, code) DO UPDATE SET
                    name = EXCLUDED.name, node_type = EXCLUDED.node_type,
                    status = EXCLUDED.status, superseded_by = EXCLUDED.superseded_by,
                    misconception = EXCLUDED.misconception
                """,
                cid, c["code"], c["name"], c.get("node_type", "concept"),
                c.get("status", "active"), c.get("superseded_by"),
                bool(c.get("misconception", False)),
            )
        for e in edges or []:
            await con.execute(
                """
                INSERT INTO concept_edges (collection_id, from_code, to_code, edge_type)
                VALUES ($1, $2, $3, $4)
                """,
                cid, e["from"], e["to"], e["edge_type"],
            )


def authed_app():
    secret = secrets.token_hex(32)
    app = create_app(require_auth=True, verifier=make_hs256_verifier(secret))

    def mint(user_id: str) -> str:
        return jwt_encode({"sub": user_id, "exp": int(time.time()) + 3600}, secret)

    return app, mint
