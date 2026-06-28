"""Protocol contract: knowledge-mcp is a public, no-auth retrieval server."""


async def test_advertises_the_retrieval_tools(mcp):
    names = set(await mcp.list_tools())
    assert {"search", "get_document", "list_sources", "list_documents"} <= names


async def test_is_public_no_token_required(mcp):
    # A tools/call with NO Authorization header must succeed — knowledge-mcp is public.
    # (On an authed server this would be 401; here it must not be.)
    res = await mcp.call("list_sources", {})
    assert not res.is_error


async def test_no_write_or_per_user_tools_advertised(mcp):
    names = set(await mcp.list_tools())
    forbidden = {"write", "delete", "scaffold_notes", "create_pack", "learner_progress",
                 "analyze_verbalization", "feedback", "reindex_source"}
    assert names.isdisjoint(forbidden)
