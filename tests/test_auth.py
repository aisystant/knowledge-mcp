"""The AUTHED (ORY JWT) mode gate.

Same codebase, different startup mode. In authed mode every request must carry a
valid Bearer token; the public server (fixture `mcp`) has no such gate. Token
verification is ORY-issued JWT (signature + standard claims); the contract here
is only the gate behaviour, not the key mechanics (those live behind the
`authed_app` seam, which wires a test signing key).
"""


async def test_authed_rejects_missing_token(authed):
    client = authed(token=None)  # anonymous against an authed server
    res = await client.call("list_sources", {})
    assert res.is_error
    assert client.last_status == 401


async def test_authed_rejects_invalid_token(authed):
    client = authed(token="not-a-real-jwt")
    res = await client.call("list_sources", {})
    assert res.is_error
    assert client.last_status == 401


async def test_authed_accepts_valid_token(authed, user_id):
    client = authed(user_id=user_id)
    res = await client.call("list_sources", {})
    assert not res.is_error
