"""Concept-graph tools: concept_status / concept_search_by_name / concept_expand
/ pack_traverse.

The graph is heterogeneous (node_type: concept | artifact) with typed edges.
concept_expand and pack_traverse share one collection-scoped BFS engine; they
differ only in the kind of node they seed from. Everything is scoped to the
caller's collections, exactly like retrieval.
"""

from .db import get_pool
from .errors import NotFound, ToolError

_ACCESS = "(c.owner = 'platform' OR c.owner = $1)"


async def concept_status(caller, concept_id=None, code=None, name=None):
    pool = await get_pool()
    if code is not None:
        pred, val = "co.code = $2", code
    elif name is not None:
        pred, val = "lower(co.name) = lower($2)", name
    elif concept_id is not None:
        pred, val = "co.id = $2", concept_id
    else:
        raise ToolError("concept_status needs one of: code, name, concept_id")
    row = await pool.fetchrow(
        f"""
        SELECT co.code, co.name, co.status, co.superseded_by, co.misconception
        FROM concepts co JOIN collections c ON c.id = co.collection_id
        WHERE {_ACCESS} AND {pred}
        LIMIT 1
        """,
        caller, val,
    )
    if row is None:
        raise NotFound("concept not found")
    parts = [f"{row['code']} {row['name']}", f"status={row['status']}"]
    if row["superseded_by"]:
        parts.append(f"superseded_by={row['superseded_by']}")
    if row["misconception"]:
        parts.append("misconception")
    return " ".join(parts)


async def concept_search_by_name(caller, name, include_inactive=False, limit=10):
    pool = await get_pool()
    status_clause = "" if include_inactive else "AND co.status = 'active'"
    rows = await pool.fetch(
        f"""
        SELECT co.code, co.name, co.status
        FROM concepts co JOIN collections c ON c.id = co.collection_id
        WHERE {_ACCESS} AND co.name ILIKE '%' || $2 || '%' {status_clause}
        ORDER BY co.name LIMIT $3
        """,
        caller, name, limit,
    )
    if not rows:
        return "No concepts."
    return "\n".join(f"{r['code']} {r['name']} ({r['status']})" for r in rows)


async def _codes_for_ids(caller, ids):
    pool = await get_pool()
    rows = await pool.fetch(
        f"""
        SELECT co.code FROM concepts co JOIN collections c ON c.id = co.collection_id
        WHERE {_ACCESS} AND co.id = ANY($2::bigint[])
        """,
        caller, ids,
    )
    return [r["code"] for r in rows]


async def _traverse(caller, seeds, edge_types, depth, limit):
    """Collection-scoped BFS over typed edges from `seeds`; returns reached codes."""
    pool = await get_pool()
    visited = set(seeds)
    frontier = list(seeds)
    reached: list[str] = []
    for _ in range(max(1, depth)):
        if not frontier or len(reached) >= limit:
            break
        rows = await pool.fetch(
            f"""
            SELECT e.to_code FROM concept_edges e JOIN collections c ON c.id = e.collection_id
            WHERE {_ACCESS}
              AND e.from_code = ANY($2::text[])
              AND ($3::text[] IS NULL OR e.edge_type = ANY($3::text[]))
            """,
            caller, frontier, edge_types,
        )
        nxt = []
        for r in rows:
            code = r["to_code"]
            if code not in visited:
                visited.add(code)
                reached.append(code)
                nxt.append(code)
        frontier = nxt
    return reached[:limit]


async def concept_expand(
    caller, code=None, concept_id=None, concept_ids=None, edge_types=None, depth=1, limit=20
):
    seeds: list[str] = []
    if code is not None:
        seeds.append(code)
    if concept_ids:
        seeds += await _codes_for_ids(caller, concept_ids)
    if concept_id is not None:
        seeds += await _codes_for_ids(caller, [concept_id])
    if not seeds:
        raise ToolError("concept_expand needs a seed: code, concept_id, or concept_ids")
    reached = await _traverse(caller, seeds, edge_types, depth, limit)
    return "\n".join(reached) if reached else "No neighbours."


async def pack_traverse(caller, seed_codes, edge_types=None, depth=2, limit=20):
    if not seed_codes:
        raise ToolError("pack_traverse needs seed_codes")
    reached = await _traverse(caller, list(seed_codes), edge_types, depth, limit)
    return "\n".join(reached) if reached else "No nodes."
