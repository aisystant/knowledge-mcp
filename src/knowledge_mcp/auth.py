"""JWT verification for the authed mode.

The production verifier will validate ORY-issued JWTs (signature via the issuer's
JWKS, plus standard claims). That is not wired yet — no contract test exercises a
real ORY token. What exists here is:

  * a minimal, dependency-free HS256 encode/decode (enough for the contract
    harness to mint and verify its own tokens), and
  * `make_hs256_verifier`, the injectable verifier the test seam uses.

A verifier is a callable ``token -> claims | None`` (None = reject).
"""

import base64
import hashlib
import hmac
import json
import time


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _b64url_decode(seg: str) -> bytes:
    return base64.urlsafe_b64decode(seg + "=" * (-len(seg) % 4))


def jwt_encode(payload: dict, secret: str) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    signing_input = (
        _b64url(json.dumps(header, separators=(",", ":")).encode())
        + "."
        + _b64url(json.dumps(payload, separators=(",", ":")).encode())
    )
    sig = hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    return signing_input + "." + _b64url(sig)


def jwt_decode(token: str, secret: str) -> dict:
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("malformed token")
    signing_input = parts[0] + "." + parts[1]
    expected = hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    if not hmac.compare_digest(expected, _b64url_decode(parts[2])):
        raise ValueError("bad signature")
    payload = json.loads(_b64url_decode(parts[1]))
    if "exp" in payload and time.time() > float(payload["exp"]):
        raise ValueError("expired")
    return payload


def make_hs256_verifier(secret: str):
    def verify(token: str) -> dict | None:
        try:
            return jwt_decode(token, secret)
        except Exception:
            return None

    return verify


def bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    parts = authorization.split()
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1]
    return None
