"""Folio's bucket on the platform's S3-compatible store: originals come out, renditions go in."""

from __future__ import annotations

from pathlib import Path

import boto3
from botocore.config import Config

from .settings import Bucket


def prefix(version: str) -> str:
    """Where a version's renditions go, as Folio's service reads them (renditionPrefix in store.ts)."""
    return f"renditions/{version}/"


class ObjectStore:
    def __init__(self, bucket: Bucket):
        self.name = bucket.name
        self.s3 = boto3.client(
            "s3",
            endpoint_url=bucket.endpoint,
            region_name=bucket.region,
            aws_access_key_id=bucket.access_key_id,
            aws_secret_access_key=bucket.secret_access_key,
            config=Config(s3={"addressing_style": "path"}),
        )

    def download(self, key: str, to: Path) -> None:
        self.s3.download_file(self.name, key, str(to))

    def put(self, key: str, body: bytes, content_type: str) -> None:
        self.s3.put_object(Bucket=self.name, Key=key, Body=body, ContentType=content_type)
