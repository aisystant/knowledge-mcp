"""A minimal MCP Streamable HTTP transport (ASGI), enough for `initialize`,
`tools/list`, and `tools/call` over JSON-RPC.

This is a deliberate, self-contained stopgap so the server is black-box testable
over the real transport without pulling in the full MCP SDK's session machinery.
It can be swapped for `mcp.server.fastmcp` later without touching the tools.

Auth lives here: in authed mode every request must carry a valid Bearer token
(else 401); the JWT `sub` becomes the caller. In public mode the caller is
`platform`. The caller is passed explicitly into each tool — no ambient state.
"""

import json
import uuid

from . import __version__
from .auth import bearer_token
from .config import PLATFORM
from .errors import ToolError

_PROTOCOL_VERSION = "2024-11-05"


async def _read_body(receive) -> bytes:
    body = b""
    while True:
        msg = await receive()
        if msg["type"] == "http.request":
            body += msg.get("body", b"")
            if not msg.get("more_body"):
                break
        else:
            break
    return body


async def _send_json(send, status, obj, extra_headers=None):
    data = json.dumps(obj).encode()
    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(data)).encode())]
    for key, val in (extra_headers or {}).items():
        headers.append((key.encode(), val.encode()))
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": data})


class MCPApp:
    """ASGI application speaking the MCP Streamable HTTP subset at ``POST /mcp``."""

    PATH = "/mcp"

    def __init__(self, tools, require_auth=False, verifier=None):
        self._tools = {t["name"]: t for t in tools}
        self._tool_defs = [
            {"name": t["name"], "description": t["description"], "inputSchema": t["inputSchema"]}
            for t in tools
        ]
        self._require_auth = require_auth
        self._verifier = verifier

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            await self._lifespan(receive, send)
            return
        if scope["type"] != "http":
            return
        if scope.get("path") != self.PATH or scope.get("method") != "POST":
            await _send_json(send, 404, {"error": "not found"})
            return

        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        caller = PLATFORM
        if self._require_auth:
            claims = None
            token = bearer_token(headers.get("authorization"))
            if token and self._verifier:
                claims = self._verifier(token)
            if not claims:
                await _send_json(
                    send, 401,
                    {"jsonrpc": "2.0", "id": None,
                     "error": {"code": -32001, "message": "unauthorized"}},
                )
                return
            caller = claims.get("sub") or PLATFORM

        try:
            req = json.loads(await _read_body(receive))
        except Exception:
            await _send_json(send, 400, {"error": "invalid json"})
            return

        envelope, extra = await self._dispatch(req, caller)
        if envelope is None:  # notification — no response body
            await send({"type": "http.response.start", "status": 202,
                        "headers": [(b"content-length", b"0")]})
            await send({"type": "http.response.body", "body": b""})
            return
        await _send_json(send, 200, envelope, extra)

    async def _dispatch(self, req, caller):
        method = req.get("method")
        rid = req.get("id")
        params = req.get("params") or {}

        if method == "initialize":
            result = {
                "protocolVersion": _PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "knowledge-mcp", "version": __version__},
            }
            return (
                {"jsonrpc": "2.0", "id": rid, "result": result},
                {"Mcp-Session-Id": uuid.uuid4().hex},
            )

        if method and method.startswith("notifications/"):
            return None, None

        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": rid, "result": {"tools": self._tool_defs}}, None

        if method == "tools/call":
            tool = self._tools.get(params.get("name"))
            if tool is None:
                name = params.get("name")
                return {"jsonrpc": "2.0", "id": rid,
                        "error": {"code": -32601, "message": f"unknown tool {name}"}}, None
            try:
                text = await tool["handler"](params.get("arguments") or {}, caller)
                result = {"content": [{"type": "text", "text": text}], "isError": False}
            except ToolError as exc:
                result = {"content": [{"type": "text", "text": str(exc)}], "isError": True}
            return {"jsonrpc": "2.0", "id": rid, "result": result}, None

        return {"jsonrpc": "2.0", "id": rid,
                "error": {"code": -32601, "message": f"unknown method {method}"}}, None

    async def _lifespan(self, receive, send):
        while True:
            msg = await receive()
            if msg["type"] == "lifespan.startup":
                await send({"type": "lifespan.startup.complete"})
            elif msg["type"] == "lifespan.shutdown":
                await send({"type": "lifespan.shutdown.complete"})
                return
