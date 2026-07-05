"""Retrieval over seeded PLATFORM collections.

Assertions stay behavioural: a query for a distinctive term returns the doc that
contains it; `source`/`source_type` scope results (provenance filter); documents
and sources are listable; get_document returns full content or just its heading
outline. Access/visibility by collection owner is a separate concern — see
test_access.py. Here everything is platform-owned and served by the public server.
"""

DOCS = [
    {"path": "guide/onboarding.md", "source": "GUIDE-onboarding", "source_type": "guides",
     "content": "# Onboarding\nThe quuxmarker explains how to begin."},
    {"path": "guide/advanced.md", "source": "GUIDE-onboarding", "source_type": "guides",
     "content": "# Advanced\nA deep dive into systems thinking."},
]


async def test_search_returns_the_matching_document(mcp, seed, collection):
    await seed(collection=collection, owner="platform", documents=DOCS)
    res = await mcp.call("search", {"query": "quuxmarker"})
    assert not res.is_error
    assert "onboarding" in res.text.lower()


async def test_search_is_scoped_by_source(mcp, seed, collection):
    await seed(collection=collection, owner="platform", documents=[
        {"path": "a.md", "source": "SRC-A", "source_type": "pack", "content": "alpha termAAA"},
        {"path": "b.md", "source": "SRC-B", "source_type": "pack", "content": "beta termBBB"},
    ])
    # termBBB lives only in SRC-B; filtering to SRC-A must not surface it.
    res = await mcp.call("search", {"query": "termBBB", "source": "SRC-A"})
    assert "termBBB" not in res.text


async def test_search_is_scoped_by_source_type(mcp, seed, collection):
    await seed(collection=collection, owner="platform", documents=[
        {"path": "p.md", "source": "SRC-P", "source_type": "pack", "content": "gamma termPACK"},
        {"path": "g.md", "source": "SRC-G", "source_type": "guides", "content": "delta termGUIDE"},
    ])
    res = await mcp.call("search", {"query": "termGUIDE", "source_type": "pack"})
    assert "termGUIDE" not in res.text


async def test_get_document_returns_full_content(mcp, seed, collection):
    await seed(collection=collection, owner="platform", documents=DOCS)
    res = await mcp.call("get_document", {"filename": "guide/onboarding.md"})
    assert not res.is_error
    assert "Onboarding" in res.text


async def test_get_document_headings_returns_outline_not_body(mcp, seed, collection):
    await seed(collection=collection, owner="platform", documents=[
        {"path": "guide/toc.md", "source": "GUIDE-onboarding", "source_type": "guides",
         "content": "# Title\nBodyword one.\n## Section\nBodyword two."},
    ])
    res = await mcp.call("get_document", {"filename": "guide/toc.md", "format": "headings"})
    assert not res.is_error
    assert "Title" in res.text and "Section" in res.text
    assert "Bodyword" not in res.text  # headings outline, not the body


async def test_list_sources_includes_seeded_source(mcp, seed, collection):
    await seed(collection=collection, owner="platform", documents=DOCS)
    res = await mcp.call("list_sources", {})
    assert "GUIDE-onboarding" in res.text


async def test_list_documents_lists_seeded_files(mcp, seed, collection):
    await seed(collection=collection, owner="platform", documents=DOCS)
    res = await mcp.call("list_documents", {"source": "GUIDE-onboarding"})
    assert "onboarding.md" in res.text
