"""Runtime configuration, read from the environment."""

import os

PLATFORM = "platform"  # sentinel owner for public collections


def database_url() -> str:
    return os.getenv("DATABASE_URL", "postgres://127.0.0.1:5432/knowledge")


def require_auth_env() -> bool:
    return os.getenv("REQUIRE_AUTH", "false").strip().lower() in ("1", "true", "yes", "on")
