"""The worker's settings, from the same environment variables as Folio's service (docs/app-storage.md)."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Bucket:
    name: str
    endpoint: str
    region: str
    access_key_id: str
    secret_access_key: str


@dataclass(frozen=True)
class Settings:
    database_url: str
    bucket: Bucket
    #: The longest one file may take; past it the worker gives up on that try.
    render_timeout: int
    #: How often to look for work when no word of new versions has come.
    poll_seconds: int


def from_env(env: os._Environ[str] | dict[str, str] = os.environ) -> Settings:
    missing = [k for k in ("DATABASE_URL", "S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY") if not env.get(k)]
    if missing:
        raise SystemExit(f"The rendition worker needs {', '.join(missing)}: give it Folio's storage (docs/app-storage.md).")
    return Settings(
        database_url=env["DATABASE_URL"],
        bucket=Bucket(
            name=env["S3_BUCKET"],
            endpoint=env["S3_ENDPOINT"],
            region=env.get("S3_REGION", "garage"),
            access_key_id=env["S3_ACCESS_KEY_ID"],
            secret_access_key=env["S3_SECRET_ACCESS_KEY"],
        ),
        render_timeout=int(env.get("RENDER_TIMEOUT_SECONDS", "1200")),
        poll_seconds=int(env.get("POLL_SECONDS", "30")),
    )
