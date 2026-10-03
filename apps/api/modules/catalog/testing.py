"""Test doubles for the catalog (used by tests and by other modules' tests; never wired at runtime)."""

import hashlib
import io
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, BinaryIO
from uuid import UUID

from api.modules.catalog.objects import MultipartFailed, ObjectMissing, StorageRegistry
from api.modules.catalog.search.opensearch import SearchUnavailable

MEMORY_PUBLIC_BASE_URL = "http://localhost:21051"
MEMORY_BUCKETS = {"nais": "nais-platform", "inst-a": "nais-inst-a", "inst-b": "nais-inst-b"}


def _etag(data: bytes) -> str:
    return f'"{hashlib.md5(data, usedforsecurity=False).hexdigest()}"'


@dataclass
class _Upload:
    key: str
    content_type: str
    parts: dict[int, bytes] = field(default_factory=dict)


class MemoryObjectStore:
    def __init__(self, bucket: str, public_base_url: str = MEMORY_PUBLIC_BASE_URL) -> None:
        self.bucket = bucket
        self._base = public_base_url.rstrip("/")
        self.objects: dict[str, bytes] = {}
        self.content_types: dict[str, str] = {}
        self.uploads: dict[str, _Upload] = {}
        self.aborted: list[str] = []
        self.presigned_gets: list[tuple[str, str, int]] = []

    def _get(self, key: str) -> bytes:
        try:
            return self.objects[key]
        except KeyError:
            raise ObjectMissing(key) from None

    def head(self, key: str) -> int | None:
        data = self.objects.get(key)
        return None if data is None else len(data)

    def open_stream(self, key: str, byte_range: tuple[int, int] | None = None) -> BinaryIO:
        data = self._get(key)
        if byte_range is not None:
            data = data[byte_range[0] : byte_range[1] + 1]
        return io.BytesIO(data)

    def read_range(self, key: str, start: int, end: int) -> bytes:
        return self._get(key)[start : end + 1]

    def put(self, key: str, data: bytes, content_type: str) -> None:
        self.objects[key] = bytes(data)
        self.content_types[key] = content_type

    def copy(self, source_key: str, key: str) -> None:
        self.put(key, self._get(source_key), self.content_types.get(source_key, "application/octet-stream"))

    def delete(self, key: str) -> None:
        self.objects.pop(key, None)

    def create_multipart(self, key: str, content_type: str) -> str:
        upload_id = uuid.uuid4().hex
        self.uploads[upload_id] = _Upload(key, content_type)
        return upload_id

    def upload_part(self, key: str, upload_id: str, part_number: int, data: bytes) -> str:
        """What a client does with a presigned UploadPart URL. Returns the part ETag."""
        upload = self.uploads.get(upload_id)
        if upload is None or upload.key != key:
            raise MultipartFailed("NoSuchUpload")
        upload.parts[part_number] = bytes(data)
        return _etag(data)

    def complete_multipart(self, key: str, upload_id: str, parts: Sequence[tuple[int, str]]) -> None:
        upload = self.uploads.get(upload_id)
        if upload is None or upload.key != key:
            raise MultipartFailed("NoSuchUpload")
        chunks = []
        for number, etag in sorted(parts):
            data = upload.parts.get(number)
            if data is None or etag.strip('"') != _etag(data).strip('"'):
                raise MultipartFailed(f"InvalidPart {number}")
            chunks.append(data)
        self.put(key, b"".join(chunks), upload.content_type)
        del self.uploads[upload_id]

    def abort_multipart(self, key: str, upload_id: str) -> None:
        if self.uploads.pop(upload_id, None) is not None:
            self.aborted.append(upload_id)

    def presign_put(
        self, key: str, content_type: str, checksum_b64: str, ttl: int
    ) -> tuple[str, dict[str, str]]:
        url = f"{self._base}/{self.bucket}/{key}?X-Amz-Expires={ttl}&X-Amz-Signature=memory"
        return url, {"Content-Type": content_type, "x-amz-checksum-sha256": checksum_b64}

    def presign_part(self, key: str, upload_id: str, part_number: int, ttl: int) -> str:
        return (
            f"{self._base}/{self.bucket}/{key}?partNumber={part_number}&uploadId={upload_id}"
            f"&X-Amz-Expires={ttl}&X-Amz-Signature=memory"
        )

    def presign_get(self, key: str, filename: str, ttl: int) -> str:
        self.presigned_gets.append((key, filename, ttl))
        return (
            f"{self._base}/{self.bucket}/{key}?response-content-disposition=attachment"
            f"&X-Amz-Expires={ttl}&X-Amz-Signature=memory"
        )


def memory_env(codes: Sequence[str]) -> dict[str, str]:
    env: dict[str, str] = {}
    for code in codes:
        prefix = "STORAGE_" + code.upper().replace("-", "_")
        env[f"{prefix}_ENDPOINT"] = f"memory://{code}"
        env[f"{prefix}_BUCKET"] = MEMORY_BUCKETS[code]
        env[f"{prefix}_ACCESS_KEY"] = "nais"
        env[f"{prefix}_SECRET_KEY"] = "nais"
    return env


def memory_registry(codes: Sequence[str] = ("nais", "inst-a", "inst-b")) -> StorageRegistry:
    return StorageRegistry(
        memory_env(codes),
        MEMORY_PUBLIC_BASE_URL,
        codes,
        factory=lambda cfg, base: MemoryObjectStore(cfg.bucket, base),
    )


def memory_store(registry: StorageRegistry, org_code: str) -> MemoryObjectStore:
    store = registry.for_org(org_code)
    assert isinstance(store, MemoryObjectStore)
    return store


class RecordingVerificationQueue:
    def __init__(self) -> None:
        self.enqueued: list[UUID] = []

    def enqueue(self, file_ids: Sequence[UUID]) -> None:
        self.enqueued.extend(file_ids)


class RecordingSearchIndex:
    """SearchIndex double for tests that do not exercise OpenSearch semantics."""

    alias = "recording"

    def __init__(self) -> None:
        self.docs: dict[str, dict[str, Any]] = {}
        self.bulk_calls = 0

    def ensure(self) -> None:
        return None

    def bulk(
        self, upserts: Sequence[Mapping[Any, Any]], deletes: Sequence[str], *, index: str | None = None
    ) -> None:
        self.bulk_calls += 1
        for doc in upserts:
            self.docs[str(doc["dataset_id"])] = dict(doc)
        for dataset_id in deletes:
            self.docs.pop(str(dataset_id), None)

    def search(self, body: Mapping[Any, Any]) -> dict[str, Any]:
        raise SearchUnavailable("RecordingSearchIndex does not search; use the search_index fixture")

    def refresh(self) -> None:
        return None

    def create_index(self, name: str, *, exist_ok: bool = True) -> None:
        return None

    def next_index_name(self) -> str:
        return "recording-v2"

    def swap_alias(self, new_index: str) -> list[str]:
        return []

    def supports_vectors(self, index: str | None = None) -> bool:
        return True
