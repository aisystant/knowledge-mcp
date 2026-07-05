"""Contract: concept-graph tools, prod-shaped.

Tools: concept_status, concept_search_by_name, concept_expand, pack_traverse.

The graph is a heterogeneous set of nodes discriminated by ``node_type``
('concept' | 'artifact') with typed edges. ``concept_expand`` walks concept
edges (specializes / part_of / related / prerequisite / contradicts) from
concept seeds; ``pack_traverse`` walks pack_* edges from artifact seeds and can
cross to concepts via ``artifact_defines_concept``. Graph nodes are collection-
scoped exactly like documents: the public server only traverses platform nodes.
"""

CONCEPTS = [
    {"code": "DP.SC.121", "name": "Axiomaticity", "status": "active", "node_type": "concept"},
    {"code": "DP.SC.900", "name": "Superseded concept", "status": "superseded",
     "superseded_by": "DP.SC.121", "node_type": "concept"},
    {"code": "MIM.FMT.001", "name": "Volitional effort", "status": "active", "node_type": "concept",
     "misconception": True},
    {"code": "U.Method", "name": "Method", "status": "active", "node_type": "concept"},
]


async def test_concept_status_active(mcp, seed, collection):
    await seed(collection=collection, owner="platform", concepts=CONCEPTS)
    res = await mcp.call("concept_status", {"code": "DP.SC.121"})
    assert not res.is_error
    assert "active" in res.text.lower()


async def test_concept_status_reports_superseded(mcp, seed, collection):
    await seed(collection=collection, owner="platform", concepts=CONCEPTS)
    res = await mcp.call("concept_status", {"code": "DP.SC.900"})
    assert "superseded" in res.text.lower()
    assert "DP.SC.121" in res.text  # points at the replacement


async def test_concept_status_flags_misconception(mcp, seed, collection):
    await seed(collection=collection, owner="platform", concepts=CONCEPTS)
    res = await mcp.call("concept_status", {"code": "MIM.FMT.001"})
    assert "misconception" in res.text.lower()


async def test_concept_search_by_name_trigram(mcp, seed, collection):
    await seed(collection=collection, owner="platform", concepts=CONCEPTS)
    res = await mcp.call("concept_search_by_name", {"name": "axiom"})
    assert not res.is_error
    assert "DP.SC.121" in res.text


async def test_concept_expand_follows_edges(mcp, seed, collection):
    await seed(
        collection=collection, owner="platform", concepts=CONCEPTS,
        edges=[{"from": "MIM.FMT.001", "to": "U.Method", "edge_type": "specializes"}],
    )
    res = await mcp.call("concept_expand", {"code": "MIM.FMT.001", "edge_types": ["specializes"]})
    assert not res.is_error
    assert "U.Method" in res.text


async def test_concept_expand_respects_edge_type_filter(mcp, seed, collection):
    await seed(
        collection=collection, owner="platform", concepts=CONCEPTS,
        edges=[{"from": "MIM.FMT.001", "to": "U.Method", "edge_type": "specializes"}],
    )
    # Asking only for 'related' must not surface a 'specializes' neighbour.
    res = await mcp.call("concept_expand", {"code": "MIM.FMT.001", "edge_types": ["related"]})
    assert "U.Method" not in res.text


async def test_pack_traverse_from_artifact_reaches_defined_concept(mcp, seed, collection):
    await seed(
        collection=collection, owner="platform",
        concepts=[
            {"code": "PACK-systems-art/pack/SA.D.001.md", "name": "SA.D.001",
             "node_type": "artifact"},
            {"code": "DP.SC.121", "name": "Axiomaticity", "node_type": "concept"},
        ],
        edges=[{"from": "PACK-systems-art/pack/SA.D.001.md", "to": "DP.SC.121",
                "edge_type": "artifact_defines_concept"}],
    )
    res = await mcp.call("pack_traverse", {
        "seed_codes": ["PACK-systems-art/pack/SA.D.001.md"],
        "edge_types": ["artifact_defines_concept"],
    })
    assert not res.is_error
    assert "DP.SC.121" in res.text


async def test_graph_traversal_is_collection_scoped(mcp, seed, collection, user_id):
    # A concept in a PERSONAL collection must not be reachable from the public server.
    await seed(
        collection=collection, owner=user_id,
        concepts=[{"code": "SECRET.1", "name": "Secret concept", "node_type": "concept"}],
    )
    res = await mcp.call("concept_search_by_name", {"name": "secret"})
    assert "SECRET.1" not in res.text
