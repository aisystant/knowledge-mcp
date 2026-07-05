"""Application entry point.

`create_app()` builds the ASGI server. It is PUBLIC (no auth) by default; the
authed (ORY JWT) mode is turned on by the `REQUIRE_AUTH` env flag (or explicitly),
in which case a verifier must be supplied. The two modes are the same code and
the same tools — only the transport's auth gate and the resolved caller differ.
"""

from .config import require_auth_env
from .tools import TOOLS
from .transport import MCPApp


def create_app(require_auth: bool | None = None, verifier=None):
    if require_auth is None:
        require_auth = require_auth_env()
    if require_auth and verifier is None:
        raise RuntimeError(
            "authed mode requires a JWT verifier (ORY JWKS wiring is not implemented yet)"
        )
    return MCPApp(TOOLS, require_auth=require_auth, verifier=verifier)
