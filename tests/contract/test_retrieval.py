"""Contract: retrieval over seeded public collections (search / get_document / list).

Assertions stay behavioural: a query for a distinctive term returns the doc that contains
it; the collection filter scopes results; documents and sources are listable. Relevance
quality is an eval concern, not a contract test.
"""

DOCS = [
    {"path": "guide/onboarding.md", "content": "# Onboarding\nThe quuxmarker explains how to begin."},
    {"path": "guide/advanced.md", "content": "# Advanced\nA deep dive into systems thinking."},
]


async def test_search_returns_the_matching_document(mcp, seed, collection):
    await seed(collection, DOCS, public=True)
    res = await mcp.call("search", {"query": "quuxmarker", "collections": [collection]})
    assert not res.is_error
    assert "onboarding" in res.text.lower()


async def test_search_is_scoped_to_requested_collections(mcp, seed, collection):
    other = f"{collection}-other"
    await seed(collection, [{"path": "a.md", "content": "alpha termAAA"}], public=True)
    await seed(other, [{"path": "b.md", "content": "beta termBBB"}], public=True)
    # termBBB lives only in `other`; filtering to `collection` must not surface it.
    res = await mcp.call("search", {"query": "termBBB", "collections": [collection]})
    assert "termBBB" not in res.text


async def test_get_document_returns_content(mcp, seed, collection):
    await seed(collection, DOCS, public=True)
    res = await mcp.call(
        "get_document", {"filename": "guide/onboarding.md", "collection": collection}
    )
    assert not res.is_error
    assert "Onboarding" in res.text


async def test_list_sources_includes_seeded_collection(mcp, seed, collection):
    await seed(collection, DOCS, public=True)
    res = await mcp.call("list_sources", {})
    assert collection in res.text


async def test_list_documents_lists_seeded_files(mcp, seed, collection):
    await seed(collection, DOCS, public=True)
    res = await mcp.call("list_documents", {"collection": collection})
    assert "onboarding.md" in res.text
