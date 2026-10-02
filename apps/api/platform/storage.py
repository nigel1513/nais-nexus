"""Institution storage settings (D-024): org code -> STORAGE_<CODE>_* env vars. Key layout/presign rules: M03."""

import os
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

_ORG_CODE = re.compile(r"^[a-z0-9-]{2,32}$")
# Explicit socket timeouts: a stalled storage node must not block a worker thread between the per-read deadline
# checks of hashing / Data Explorer reads (read_timeout bounds each socket read, not the whole transfer).
S3_CONNECT_TIMEOUT_S = 5
S3_READ_TIMEOUT_S = 30
S3_MAX_ATTEMPTS = 2  # initial try + 1 retry: one call is bounded by about 2 x (connect + read timeout)
_S3_CONFIG = Config(
    signature_version="s3v4",
    s3={"addressing_style": "path"},
    retries={"total_max_attempts": S3_MAX_ATTEMPTS},
    connect_timeout=S3_CONNECT_TIMEOUT_S,
    read_timeout=S3_READ_TIMEOUT_S,
)


class StorageNotConfigured(LookupError):
    pass


@dataclass(frozen=True)
class StorageConfig:
    org_code: str
    endpoint: str
    bucket: str
    access_key: str
    secret_key: str


def env_prefix(org_code: str) -> str:
    if not _ORG_CODE.fullmatch(org_code):
        raise ValueError(f"invalid organization code: {org_code!r}")
    return "STORAGE_" + org_code.upper().replace("-", "_")


def load_storage_config(org_code: str, environ: Mapping[str, str] = os.environ) -> StorageConfig:
    prefix = env_prefix(org_code)
    values: dict[str, str] = {}
    for field in ("ENDPOINT", "BUCKET", "ACCESS_KEY", "SECRET_KEY"):
        name = f"{prefix}_{field}"
        if not environ.get(name):
            raise StorageNotConfigured(f"{name} is not set for organization {org_code!r}")
        values[field.lower()] = environ[name]
    return StorageConfig(org_code=org_code, **values)


def _client(cfg: StorageConfig, endpoint: str) -> Any:
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=cfg.access_key,
        aws_secret_access_key=cfg.secret_key,
        region_name="us-east-1",
        config=_S3_CONFIG,
    )


def internal_client(cfg: StorageConfig) -> Any:
    """For server-side calls inside the compose network (HEAD, hashing, multipart complete)."""
    return _client(cfg, cfg.endpoint)


def public_client(cfg: StorageConfig, public_base_url: str) -> Any:
    """For presigning URLs that browsers call through the :21051 gateway. Never used for direct calls."""
    return _client(cfg, public_base_url.rstrip("/"))


def ensure_buckets(org_codes: Sequence[str], environ: Mapping[str, str] = os.environ) -> list[str]:
    created: list[str] = []
    for code in org_codes:
        cfg = load_storage_config(code, environ)
        client = internal_client(cfg)
        try:
            client.head_bucket(Bucket=cfg.bucket)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") not in ("404", "NoSuchBucket", "NotFound"):
                raise
            client.create_bucket(Bucket=cfg.bucket)
            created.append(cfg.bucket)
    return created
