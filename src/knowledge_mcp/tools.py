"""The tool surface: name, description, input schema, and handler for each tool.

Handlers are ``async (arguments: dict, caller: str) -> str``. The caller identity
is resolved by the transport (``platform`` in public mode, the JWT ``sub`` in
authed mode) and threaded in explicitly — no ambient state.
"""

from . import graph, retrieval

_OBJ = {"type": "object", "properties": {}}


async def _search(a, caller):
    return await retrieval.search(
        caller, a["query"], a.get("source"), a.get("source_type"), a.get("limit", 5)
    )


async def _get_document(a, caller):
    return await retrieval.get_document(
        caller, a["filename"], a.get("source"), a.get("format", "full")
    )


async def _list_sources(a, caller):
    return await retrieval.list_sources(caller, a.get("source_type"))


async def _list_documents(a, caller):
    return await retrieval.list_documents(
        caller, a.get("source"), a.get("source_type"), a.get("limit", 100)
    )


async def _concept_status(a, caller):
    return await graph.concept_status(caller, a.get("concept_id"), a.get("code"), a.get("name"))


async def _concept_search_by_name(a, caller):
    return await graph.concept_search_by_name(
        caller, a["name"], a.get("include_inactive", False), a.get("limit", 10)
    )


async def _concept_expand(a, caller):
    return await graph.concept_expand(
        caller, a.get("code"), a.get("concept_id"), a.get("concept_ids"),
        a.get("edge_types"), a.get("depth", 1), a.get("limit", 20),
    )


async def _pack_traverse(a, caller):
    return await graph.pack_traverse(
        caller, a.get("seed_codes", []), a.get("edge_types"), a.get("depth", 2), a.get("limit", 20)
    )


TOOLS = [
    {"name": "search", "description": "Hybrid search over the corpus (keyword path), "
     "filterable by source / source_type.", "inputSchema": _OBJ, "handler": _search},
    {"name": "get_document", "description": "A document in full, or its heading outline "
     "(format=headings), by filename.", "inputSchema": _OBJ, "handler": _get_document},
    {"name": "list_sources", "description": "Sources with document counts.",
     "inputSchema": _OBJ, "handler": _list_sources},
    {"name": "list_documents", "description": "Files within a source.",
     "inputSchema": _OBJ, "handler": _list_documents},
    {"name": "concept_status", "description": "Status of a concept (active/deprecated/"
     "superseded) with superseded_by and the misconception flag.",
     "inputSchema": _OBJ, "handler": _concept_status},
    {"name": "concept_search_by_name", "description": "Fuzzy concept lookup by name.",
     "inputSchema": _OBJ, "handler": _concept_search_by_name},
    {"name": "concept_expand", "description": "BFS from concept seeds over concept edges.",
     "inputSchema": _OBJ, "handler": _concept_expand},
    {"name": "pack_traverse", "description": "BFS from artifact seeds over pack edges and "
     "the artifact_defines_concept bridge.", "inputSchema": _OBJ, "handler": _pack_traverse},
]
