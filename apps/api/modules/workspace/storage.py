"""OutputStorage over the platform storage clients (api.platform.storage; catalog internals are not imported).

Mirrors the catalog's client split: presigned URLs are signed by the public client (browsers reach storage through
the :21051 gateway), HEAD and hashing go through the internal client inside the compose network.
"""

import base64
import hashlib
import os
import threading
from collections.abc import Mapping
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.storage import (
    StorageConfig,
    StorageNotConfigured,
    internal_client,
    load_storage_config,
    public_client,
)

CHUNK_BYTES = 1024 * 1024  # hashing reads at most this much at a time
_MISSING = frozenset({"404", "NoSuchKey", "NotFound"})


def _unavailable(message: str) -> ApiError:
    return ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, message)


def _missing(exc: ClientError) -> bool:
    return str(exc.response.get("Error", {}).get("Code", "")) in _MISSING


class S3OutputStorage:
    def __init__(self, public_base_url: str, environ: Mapping[str, str] = os.environ) -> None:
        self._public_base_url = public_base_url
        self._environ = environ
        self._clients: dict[tuple[str, str], Any] = {}
        self._lock = threading.Lock()

    def _config(self, org_code: str) -> StorageConfig:
        try:
            return load_storage_config(org_code, self._environ)
        except (StorageNotConfigured, ValueError) as exc:
            raise _unavailable(f"Storage is not configured for organization {org_code!r}.") from exc

    def _client(self, org_code: str, kind: str) -> Any:
        with self._lock:
            client = self._clients.get((org_code, kind))
            if client is None:
                cfg = self._config(org_code)
                client = (
                    internal_client(cfg) if kind == "internal" else public_client(cfg, self._public_base_url)
                )
                self._clients[(org_code, kind)] = client
            return client

    def internal(self, org_code: str) -> Any:
        return self._client(org_code, "internal")

    def _bucket(self, org_code: str) -> str:
        return self._config(org_code).bucket

    def presign_put(
        self, org_code: str, key: str, content_type: str, sha256_hex: str, ttl: int
    ) -> tuple[str, dict[str, str]]:
        checksum = base64.b64encode(bytes.fromhex(sha256_hex)).decode()
        url = self._client(org_code, "public").generate_presigned_url(
            "put_object",
            Params={
                "Bucket": self._bucket(org_code),
                "Key": key,
                "ContentType": content_type,
                "ChecksumSHA256": checksum,
            },
            ExpiresIn=ttl,
        )
        return str(url), {"Content-Type": content_type, "x-amz-checksum-sha256": checksum}

    def presign_get(self, org_code: str, key: str, filename: str, ttl: int) -> str:
        url = self._client(org_code, "public").generate_presigned_url(
            "get_object",
            Params={
                "Bucket": self._bucket(org_code),
                "Key": key,
                "ResponseContentDisposition": f'attachment; filename="{filename}"',
            },
            ExpiresIn=ttl,
        )
        return str(url)

    def head(self, org_code: str, key: str) -> int | None:
        try:
            response = self.internal(org_code).head_object(Bucket=self._bucket(org_code), Key=key)
        except ClientError as exc:
            if _missing(exc):
                return None
            raise _unavailable("Storage is unavailable.") from exc
        except BotoCoreError as exc:
            raise _unavailable("Storage is unavailable.") from exc
        return int(response["ContentLength"])

    def sha256(self, org_code: str, key: str) -> str | None:
        try:
            body = self.internal(org_code).get_object(Bucket=self._bucket(org_code), Key=key)["Body"]
        except ClientError as exc:
            if _missing(exc):
                return None
            raise _unavailable("Storage is unavailable.") from exc
        except BotoCoreError as exc:
            raise _unavailable("Storage is unavailable.") from exc
        digest = hashlib.sha256()
        try:
            for chunk in body.iter_chunks(CHUNK_BYTES):
                digest.update(chunk)
        except BotoCoreError as exc:
            raise _unavailable("Storage is unavailable.") from exc
        finally:
            body.close()
        return digest.hexdigest()
