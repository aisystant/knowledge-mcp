"""Black-box contract harness for knowledge-mcp.

Tests drive the server through the real MCP Streamable HTTP transport
(`tools/list`, `tools/call`). knowledge-mcp runs in one of two modes, from a
SINGLE codebase, chosen at startup:

  * PUBLIC (default)  — no auth. Only platform-owned collections are visible.
  * AUTHED (ORY JWT)  — every request must carry a valid Bearer token. The
                        caller identity (JWT `sub`) unlocks the collections it
                        owns, in addition to the platform ones.

Access is per-collection: every knowledge object (document, concept, artifact)
belongs to exactly one collection, and a collection has exactly one owner —
either the sentinel ``"platform"`` (public) or a user id. The rule applied on
every request is::

    collection.owner == "platform"  OR  collection.owner == caller

`source`/`source_type` are an ORTHOGONAL axis (provenance / search filter), NOT
access: a personal DS-vault and a platform Pack are both just ``source``s; what
gates them is their collection owner.

Test data is seeded through a test-only seam the implementation provides
(`knowledge_mcp.contract_testing`); tests never touch the storage schema
directly. Each test uses a fresh, uniquely-named collection.

Red until the server (`knowledge_mcp.app.create_app`) and the seam exist.
"""

import json
import uuid

import httpx
import pytest
import pytest_asyncio


@pytest.fixture
def collection() -> str:
    """A fresh, unique collection name per test."""
    return f"contract-{uuid.uuid4().hex[:12]}"


@pytest.fixture
def user_id() -> str:
    """A fresh, unique user id (stands in for an ORY identity UUID)."""
    return str(uuid.uuid4())


@pytest_asyncio.fixture
async def seed():
    """Async seed helper. One call seeds one collection with one owner::

        await seed(
            collection="…",
            owner="platform" | "<user_id>",          # access axis
            documents=[{path, content, source, source_type}],
            concepts=[{code, name, status?, node_type?,
                       misconception?, superseded_by?}],
            edges=[{from, to, edge_type}],            # from/to are node codes
        )

    ``owner`` defaults to ``"platform"`` (public). ``documents``/``concepts``/
    ``edges`` are all optional. It is a test-only affordance — production
    ingestion is the separate indexer.
    """
    from knowledge_mcp.contract_testing import seed as _seed

    return _seed


class AuthError(Exception):
    """Raised when the transport rejects a request (HTTP 401/403)."""

    def __init__(self, status: int):
        super().__init__(f"auth rejected: {status}")
        self.status = status


class ToolResult:
    def __init__(self, text: str, is_error: bool):
        self.text = text
        self.is_error = is_error


def _parse(response: httpx.Response) -> dict:
    if response.headers.get("content-type", "").startswith("text/event-stream"):
        for line in response.text.splitlines():
            if line.startswith("data:"):
                return json.loads(line[5:].strip())
        raise AssertionError("no data frame in SSE response")
    return response.json()


class MCPClient:
    """Minimal MCP Streamable HTTP client over an in-process ASGI app.

    Pass ``token`` to send ``Authorization: Bearer <token>`` on every request
    (``None`` → no Authorization header, i.e. an anonymous caller). After any
    call, ``last_status`` holds the HTTP status of the most recent request —
    use it to assert a transport-level 401 on rejection.
    """

    PATH = "/mcp"

    def __init__(self, client: httpx.AsyncClient, token: str | None = None):
        self._c = client
        self._token = token
        self._sid: str | None = None
        self._n = 0
        self.last_status: int | None = None

    def _headers(self) -> dict:
        h = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
        if self._token:
            h["Authorization"] = f"Bearer {self._token}"
        if self._sid:
            h["Mcp-Session-Id"] = self._sid
        return h

    async def _rpc(self, method: str, params: dict) -> dict:
        self._n += 1
        body = {"jsonrpc": "2.0", "id": self._n, "method": method, "params": params}
        r = await self._c.post(self.PATH, json=body, headers=self._headers())
        self.last_status = r.status_code
        if r.status_code in (401, 403):
            raise AuthError(r.status_code)
        r.raise_for_status()
        if sid := r.headers.get("Mcp-Session-Id"):
            self._sid = sid
        return _parse(r)

    async def _ensure_session(self) -> None:
        if self._sid:
            return
        await self._rpc(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "contract-tests", "version": "0"},
            },
        )

    async def list_tools(self) -> list[str]:
        await self._ensure_session()
        res = await self._rpc("tools/list", {})
        return [t["name"] for t in res["result"]["tools"]]

    async def call(self, name: str, arguments: dict) -> ToolResult:
        try:
            await self._ensure_session()
            res = await self._rpc("tools/call", {"name": name, "arguments": arguments})
        except AuthError as e:
            return ToolResult(text=f"unauthorized ({e.status})", is_error=True)
        if "error" in res:
            return ToolResult(text=str(res["error"].get("message", "")), is_error=True)
        result = res["result"]
        text = "".join(
            block.get("text", "")
            for block in result.get("content", [])
            if block.get("type") == "text"
        )
        return ToolResult(text=text, is_error=bool(result.get("isError")))


@pytest_asyncio.fixture
async def mcp():
    """PUBLIC-mode client (no auth) — the default deployment."""
    from knowledge_mcp.app import create_app

    app = create_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://contract.test") as client:
        yield MCPClient(client)


@pytest_asyncio.fixture
async def authed():
    """AUTHED-mode (ORY JWT) client factory.

    ``authed_app()`` builds the server in authed mode wired to a test signing
    key and returns ``(app, mint)``, where ``mint(user_id)`` issues a token the
    server accepts. The factory yielded here builds clients::

        client = authed(user_id="…")        # valid token for that user
        client = authed(token=None)          # anonymous (no token)
        client = authed(token="garbage")     # invalid token

    Both the public server and this authed server read the SAME database, so a
    collection seeded with ``owner=<user_id>`` is the one this caller unlocks.
    """
    from knowledge_mcp.contract_testing import authed_app

    app, mint = authed_app()
    transport = httpx.ASGITransport(app=app)
    _sentinel = object()
    async with httpx.AsyncClient(transport=transport, base_url="http://contract.test") as client:

        def make(user_id: str | None = None, token=_sentinel) -> MCPClient:
            if token is _sentinel:
                token = mint(user_id) if user_id else None
            return MCPClient(client, token=token)

        make.mint = mint
        yield make
