"""Protocol: the tool surface and the public-by-default posture."""

RETRIEVAL_TOOLS = {"search", "get_document", "list_sources", "list_documents"}
GRAPH_TOOLS = {"concept_status", "concept_search_by_name", "concept_expand", "pack_traverse"}


async def test_advertises_the_retrieval_tools(mcp):
    names = set(await mcp.list_tools())
    assert RETRIEVAL_TOOLS <= names


async def test_advertises_the_concept_graph_tools(mcp):
    # Prod-shaped graph tools: concept_expand (from concept seeds) +
    # pack_traverse (from artifact seeds). A merged graph_traverse is future work.
    names = set(await mcp.list_tools())
    assert GRAPH_TOOLS <= names


async def test_is_public_no_token_required(mcp):
    # PUBLIC mode: a tools/call with NO Authorization header must succeed.
    # (On the authed server this would be 401 — see test_auth.py.)
    res = await mcp.call("list_sources", {})
    assert not res.is_error


async def test_no_write_or_per_user_tools_advertised(mcp):
    names = set(await mcp.list_tools())
    # Writes and per-user/learner tools do NOT live here: learner mastery moved
    # to digital-twin; ops/analytics endpoints are not Guide-facing tools.
    forbidden = {
        "write", "delete", "scaffold_notes", "create_pack",
        "learner_progress", "analyze_verbalization", "feedback",
        "reindex_source", "graph_stats", "feedback_stats",
    }
    assert names.isdisjoint(forbidden)
