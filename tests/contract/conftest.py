"""Black-box contract harness for knowledge-mcp (PUBLIC, read-only, no auth).

Tests drive the server through the real MCP transport (`tools/list`, `tools/call`).
knowledge-mcp is **public**: tools are callable WITHOUT any token — there is no auth.

Test data is seeded into fresh, uniquely-named collections through a test-only seed seam
the implementation provides (`knowledge_mcp.contract_testing.seed`); tests never touch the
storage schema directly. Each test uses a fresh collection name, so they don't interfere.

Red until the server (`knowledge_mcp.app.create_app`) and the seed seam exist.
"""

import json
import uuid

import httpx
import pytest
import pytest_asyncio


@pytest.fixture
def collection():
    """A fresh, unique collection name per test."""
    return f"contract-{uuid.uuid4().hex[:12]}"


@pytest_asyncio.fixture
async def seed():
    """Async seed helper: `await seed(collection, docs, public=True)`.

    `docs` is a list of `{"path", "content"}`. The implementation chunks/embeds and stores
    them in the given collection. It is a test-only affordance — production ingestion is the
    separate indexer.
    """
    from knowledge_mcp.contract_testing import seed as _seed

    return _seed


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
    """Minimal MCP Streamable HTTP client over an in-process ASGI app (no auth)."""

    PATH = "/mcp"

    def __init__(self, client: httpx.AsyncClient):
        self._c = client
        self._sid: str | None = None
        self._n = 0

    def _headers(self) -> dict:
        h = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
        if self._sid:
            h["Mcp-Session-Id"] = self._sid
        return h

    async def _rpc(self, method: str, params: dict) -> dict:
        self._n += 1
        body = {"jsonrpc": "2.0", "id": self._n, "method": method, "params": params}
        r = await self._c.post(self.PATH, json=body, headers=self._headers())
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
        await self._ensure_session()
        res = await self._rpc("tools/call", {"name": name, "arguments": arguments})
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
    from knowledge_mcp.app import create_app

    app = create_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://contract.test") as client:
        yield MCPClient(client)
