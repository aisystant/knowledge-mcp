"""Tool-level errors. Raised by tool handlers; the transport turns them into an
MCP tool result with ``isError: true`` (not a JSON-RPC protocol error)."""


class ToolError(Exception):
    """A tool could not fulfil the request (bad args, etc.)."""


class NotFound(ToolError):
    """The requested item does not exist or is not accessible to the caller."""
