"""Object storage for the catalog (M03 §4.8, §6.6). Built on api.platform.storage (D-024).

Internal client = HEAD, hashing, multipart complete (compose network). Public client = presigning only, so browsers
reach the bucket through the :21051 gateway (path-style, SigV4, us-east-1).
"""

import threading
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from typing import Any, BinaryIO, Protocol, cast

from botocore.exceptions import BotoCoreError, ClientError

from api.platform.storage import (
    StorageConfig,
    StorageNotConfigured,
    internal_client,
    load_storage_config,
    public_client,
)

_MISSING = frozenset({"404", "NoSuchKey", "NotFound", "NoSuchUpload"})


class StorageUnavailable(RuntimeError):
    """Storage unreachable, 5xx, or credentials rejected. Maps to 503 DEPENDENCY_UNAVAILABLE."""


class ObjectMissing(LookupError):
    pass


class MultipartFailed(RuntimeError):
    """CompleteMultipartUpload rejected (unknown upload id, wrong ETag, missing part)."""


class ObjectStore(Protocol):
    bucket: str

    def head(self, key: str) -> int | None: ...
    def open_stream(self, key: str, byte_range: tuple[int, int] | None = None) -> BinaryIO: ...
    def read_range(self, key: str, start: int, end: int) -> bytes: ...
    def put(self, key: str, data: bytes, content_type: str) -> None: ...
    def delete(self, key: str) -> None: ...
    def create_multipart(self, key: str, content_type: str) -> str: ...
    def complete_multipart(self, key: str, upload_id: str, parts: Sequence[tuple[int, str]]) -> None: ...
    def abort_multipart(self, key: str, upload_id: str) -> None: ...
    def presign_put(
        self, key: str, content_type: str, checksum_b64: str, ttl: int
    ) -> tuple[str, dict[str, str]]: ...
    def presign_part(self, key: str, upload_id: str, part_number: int, ttl: int) -> str: ...
    def presign_get(self, key: str, filename: str, ttl: int) -> str: ...


def _code(exc: ClientError) -> str:
    return str(exc.response.get("Error", {}).get("Code", ""))


def _status(exc: ClientError) -> int:
    return int(exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0) or 0)


@contextmanager
def _translate() -> Iterator[None]:
    """Connection problems, 5xx and auth failures become StorageUnavailable; other ClientErrors propagate."""
    try:
        yield
    except BotoCoreError as exc:
        raise StorageUnavailable(str(exc)) from exc
    except ClientError as exc:
        if _status(exc) >= 500 or _status(exc) in (401, 403):
            raise StorageUnavailable(str(exc)) from exc
        raise


class S3ObjectStore:
    def __init__(self, cfg: StorageConfig, public_base_url: str) -> None:
        self.bucket = cfg.bucket
        self._internal: Any = internal_client(cfg)
        self._public: Any = public_client(cfg, public_base_url)

    def head(self, key: str) -> int | None:
        try:
            with _translate():
                return int(self._internal.head_object(Bucket=self.bucket, Key=key)["ContentLength"])
        except ClientError as exc:
            if _code(exc) in _MISSING:
                return None
            raise

    def open_stream(self, key: str, byte_range: tuple[int, int] | None = None) -> BinaryIO:
        params: dict[str, Any] = {"Bucket": self.bucket, "Key": key}
        if byte_range is not None:
            params["Range"] = f"bytes={byte_range[0]}-{byte_range[1]}"
        try:
            with _translate():
                return cast(BinaryIO, self._internal.get_object(**params)["Body"])
        except ClientError as exc:
            if _code(exc) in _MISSING:
                raise ObjectMissing(key) from exc
            raise

    def read_range(self, key: str, start: int, end: int) -> bytes:
        body = self.open_stream(key, (start, end))
        try:
            with _translate():
                return body.read()
        finally:
            body.close()

    def put(self, key: str, data: bytes, content_type: str) -> None:
        with _translate():
            self._internal.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)

    def delete(self, key: str) -> None:
        with _translate():
            self._internal.delete_object(Bucket=self.bucket, Key=key)

    def create_multipart(self, key: str, content_type: str) -> str:
        with _translate():
            response = self._internal.create_multipart_upload(
                Bucket=self.bucket, Key=key, ContentType=content_type
            )
        return str(response["UploadId"])

    def complete_multipart(self, key: str, upload_id: str, parts: Sequence[tuple[int, str]]) -> None:
        try:
            with _translate():
                self._internal.complete_multipart_upload(
                    Bucket=self.bucket,
                    Key=key,
                    UploadId=upload_id,
                    MultipartUpload={"Parts": [{"PartNumber": n, "ETag": etag} for n, etag in sorted(parts)]},
                )
        except ClientError as exc:
            raise MultipartFailed(f"{_code(exc)}: {exc}") from exc

    def abort_multipart(self, key: str, upload_id: str) -> None:
        try:
            with _translate():
                self._internal.abort_multipart_upload(Bucket=self.bucket, Key=key, UploadId=upload_id)
        except ClientError as exc:
            if _code(exc) not in _MISSING:
                raise

    def presign_put(
        self, key: str, content_type: str, checksum_b64: str, ttl: int
    ) -> tuple[str, dict[str, str]]:
        url = self._public.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": self.bucket,
                "Key": key,
                "ContentType": content_type,
                "ChecksumSHA256": checksum_b64,
            },
            ExpiresIn=ttl,
        )
        return str(url), {"Content-Type": content_type, "x-amz-checksum-sha256": checksum_b64}

    def presign_part(self, key: str, upload_id: str, part_number: int, ttl: int) -> str:
        return str(
            self._public.generate_presigned_url(
                "upload_part",
                Params={"Bucket": self.bucket, "Key": key, "UploadId": upload_id, "PartNumber": part_number},
                ExpiresIn=ttl,
            )
        )

    def presign_get(self, key: str, filename: str, ttl: int) -> str:
        return str(
            self._public.generate_presigned_url(
                "get_object",
                Params={
                    "Bucket": self.bucket,
                    "Key": key,
                    "ResponseContentDisposition": f'attachment; filename="{filename}"',
                },
                ExpiresIn=ttl,
            )
        )


StoreFactory = Callable[[StorageConfig, str], ObjectStore]


class StorageRegistry:
    """Organization code -> ObjectStore, from STORAGE_<CODE>_* variables (D-024)."""

    def __init__(
        self,
        environ: Mapping[str, str],
        public_base_url: str,
        org_codes: Sequence[str],
        factory: StoreFactory = S3ObjectStore,
    ) -> None:
        self._environ = dict(environ)
        self._public_base_url = public_base_url
        self._org_codes = tuple(org_codes)
        self._factory = factory
        self._stores: dict[str, ObjectStore] = {}
        self._lock = threading.Lock()

    def config(self, org_code: str) -> StorageConfig:
        try:
            return load_storage_config(org_code, self._environ)
        except ValueError as exc:
            raise StorageNotConfigured(str(exc)) from exc

    def is_configured(self, org_code: str) -> bool:
        try:
            self.config(org_code)
        except StorageNotConfigured:
            return False
        return True

    def for_org(self, org_code: str) -> ObjectStore:
        with self._lock:
            store = self._stores.get(org_code)
            if store is None:
                store = self._factory(self.config(org_code), self._public_base_url)
                self._stores[org_code] = store
            return store

    def for_bucket(self, bucket: str) -> ObjectStore:
        for code in self._org_codes:
            if self.is_configured(code) and self.config(code).bucket == bucket:
                return self.for_org(code)
        raise StorageNotConfigured(f"no storage configuration for bucket {bucket!r}")
