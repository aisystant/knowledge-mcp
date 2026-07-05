"""Ingestion pipeline: the indexer's idempotency contract.

A producer (CI on git push) calls `enqueue(...)` with raw documents; a worker
drains the queue via `process_pending()`, writing into the same tables the MCP
server reads. The producer is dumb -- it does not consult what is already
indexed; the indexer owns change-detection by content hash.

Pinned here, end to end (enqueue -> process -> the public server retrieves it):
  * unchanged content already indexed -> enqueue skips it (the indexer decides)
  * re-enqueue before the queue drains -> no duplicate job
  * changed content -> re-indexed, latest wins, even if changed while queued

Red until `knowledge_mcp.indexer` and the ingest-queue migration exist.
"""

from knowledge_mcp.indexer import enqueue, pending_count, process_pending

DOC = {"path": "guide/intro.md", "source": "GUIDE", "source_type": "guides",
       "content": "# Intro\nThe zephyrmark token lives here."}


async def test_enqueue_then_process_makes_it_retrievable(mcp, collection):
    r = await enqueue(collection=collection, owner="platform", documents=[DOC])
    assert r["enqueued"] == 1
    await process_pending()
    res = await mcp.call("search", {"query": "zephyrmark"})
    assert not res.is_error
    assert "intro" in res.text.lower()


async def test_enqueue_skips_unchanged_already_indexed(collection):
    # The producer stays dumb; enqueue (indexer-side) skips content already indexed.
    await enqueue(collection=collection, owner="platform", documents=[DOC])
    await process_pending()
    again = await enqueue(collection=collection, owner="platform", documents=[DOC])
    assert again["enqueued"] == 0
    assert again["skipped"] == 1


async def test_reenqueue_before_drain_does_not_duplicate(collection):
    # Second submit before the worker runs must not add a second job.
    await enqueue(collection=collection, owner="platform", documents=[DOC])
    await enqueue(collection=collection, owner="platform", documents=[DOC])
    assert await pending_count(collection) == 1


async def test_changed_content_is_reindexed(mcp, collection):
    v1 = {**DOC, "content": "# Intro\nalphaterm only."}
    v2 = {**DOC, "content": "# Intro\nbetaterm only."}
    await enqueue(collection=collection, owner="platform", documents=[v1])
    await process_pending()
    await enqueue(collection=collection, owner="platform", documents=[v2])
    await process_pending()
    assert "intro" in (await mcp.call("search", {"query": "betaterm"})).text.lower()
    assert "alphaterm" not in (await mcp.call("search", {"query": "alphaterm"})).text.lower()


async def test_change_while_queued_keeps_latest_without_duplicate(mcp, collection):
    v1 = {**DOC, "content": "# Intro\ngammaterm one."}
    v2 = {**DOC, "content": "# Intro\ndeltaterm two."}
    await enqueue(collection=collection, owner="platform", documents=[v1])
    await enqueue(collection=collection, owner="platform", documents=[v2])  # changed, still pending
    assert await pending_count(collection) == 1
    await process_pending()
    assert "intro" in (await mcp.call("search", {"query": "deltaterm"})).text.lower()
    assert "gammaterm" not in (await mcp.call("search", {"query": "gammaterm"})).text.lower()
