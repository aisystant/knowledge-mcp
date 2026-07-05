"""Per-collection access.

One owner per collection; ``platform`` is the public owner. The rule enforced on
every request is: ``owner == platform  OR  owner == caller``. There is no group
sharing — a collection is either public (platform) or one user's personal one.

The PUBLIC server (fixture `mcp`) is an anonymous caller: it sees only platform
collections. The AUTHED server (fixture `authed`) resolves the caller from the
JWT `sub`, which unlocks that user's own collections on top of the platform ones.
"""

PLATFORM_DOC = {"path": "pub.md", "source": "SRC-PUB", "source_type": "guides",
                "content": "publicmarker in a platform doc"}
PRIVATE_DOC = {"path": "priv.md", "source": "SRC-PRIV", "source_type": "ds",
               "content": "secretmarker in a personal doc"}


# ---- PUBLIC server: only platform collections are visible ------------------

async def test_public_sees_platform_collection(mcp, seed, collection):
    await seed(collection=collection, owner="platform", documents=[PLATFORM_DOC])
    res = await mcp.call("search", {"query": "publicmarker"})
    assert not res.is_error
    assert "publicmarker" in res.text.lower()


async def test_public_cannot_see_personal_collection(mcp, seed, collection, user_id):
    await seed(collection=collection, owner=user_id, documents=[PRIVATE_DOC])
    res = await mcp.call("search", {"query": "secretmarker"})
    assert "secretmarker" not in res.text.lower()


async def test_public_list_sources_hides_personal_source(mcp, seed, collection, user_id):
    await seed(collection=collection, owner=user_id, documents=[PRIVATE_DOC])
    res = await mcp.call("list_sources", {})
    assert "SRC-PRIV" not in res.text


async def test_public_get_document_denies_personal_doc(mcp, seed, collection, user_id):
    await seed(collection=collection, owner=user_id, documents=[PRIVATE_DOC])
    res = await mcp.call("get_document", {"filename": "priv.md"})
    # May be an error or empty, but must never leak the personal content.
    assert "secretmarker" not in res.text.lower()


# ---- AUTHED server: the caller unlocks its own collections -----------------

async def test_owner_sees_own_personal_collection(authed, seed, collection, user_id):
    await seed(collection=collection, owner=user_id, documents=[PRIVATE_DOC])
    client = authed(user_id=user_id)
    res = await client.call("search", {"query": "secretmarker"})
    assert not res.is_error
    assert "secretmarker" in res.text.lower()


async def test_other_user_cannot_see_someones_personal_collection(
    authed, seed, collection, user_id
):
    await seed(collection=collection, owner=user_id, documents=[PRIVATE_DOC])
    other = authed(user_id="00000000-0000-0000-0000-000000000000")
    res = await other.call("search", {"query": "secretmarker"})
    assert "secretmarker" not in res.text.lower()


async def test_authed_user_still_sees_platform(authed, seed, collection, user_id):
    await seed(collection=collection, owner="platform", documents=[PLATFORM_DOC])
    client = authed(user_id=user_id)
    res = await client.call("search", {"query": "publicmarker"})
    assert not res.is_error
    assert "publicmarker" in res.text.lower()
