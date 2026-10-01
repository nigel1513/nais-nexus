"""Catalog public interface (M03 §8, D-024). Other modules import only this file (or its alias
api.modules.catalog.ports) and look the implementations up with api.platform.ports.get(<Protocol>)."""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, BinaryIO, Literal, Protocol
from uuid import UUID

from api.platform.auth import CurrentUser

AccessLevel = Literal["PUBLIC", "INTERNAL", "CONTROLLED", "SENSITIVE"]


@dataclass(frozen=True)
class DatasetPolicyView:
    dataset_id: UUID
    owner_organization_id: UUID
    access_level: AccessLevel
    allowed_purposes: tuple[str, ...]
    approval_required: bool
    max_grant_days: int
    status: Literal["ACTIVE", "WITHDRAWN"]
    title: str


@dataclass(frozen=True)
class FileRef:
    file_id: UUID
    path: str
    size_bytes: int
    sha256: str
    media_type: str
    status: Literal["PENDING", "UPLOADED", "VERIFIED", "FAILED"]
    storage_bucket: str  # internal only: never in API responses, events or logs
    storage_key: str


@dataclass(frozen=True)
class VersionView:
    dataset_version_id: UUID
    dataset_id: UUID
    owner_organization_id: UUID
    version_label: str
    status: Literal["DRAFT", "PUBLISHED", "WITHDRAWN"]
    manifest_sha256: str | None
    metadata_snapshot: dict[str, Any] | None  # not None only for PUBLISHED (and WITHDRAWN) versions
    files: tuple[FileRef, ...]  # path ascending (UTF-8 byte order)


@dataclass(frozen=True)
class PresignedGet:
    file_id: UUID
    path: str
    url: str
    size_bytes: int
    sha256: str
    expires_at: datetime


class CatalogNotFound(ValueError):  # noqa: N818  (spec: "ValueError(NOT_FOUND)")
    def __init__(self, detail: str = "") -> None:
        super().__init__(f"NOT_FOUND: {detail}" if detail else "NOT_FOUND")


class ObjectMissing(LookupError):  # noqa: N818
    """CatalogReadPort.open_stream: the object is not in storage (404). M05 fails the run with FILE_NOT_FOUND."""


class StorageUnavailable(RuntimeError):  # noqa: N818
    """CatalogReadPort.open_stream: connection refused, timeout or 5xx. Retryable (M05 retries the run)."""


class CatalogQueryPort(Protocol):
    """For Governance (M04) and Readiness (M05). Makes no access decision except is_visible (D-012)."""

    def get_policy_view(self, dataset_id: UUID) -> DatasetPolicyView | None: ...
    def get_version(self, dataset_version_id: UUID) -> VersionView | None: ...
    def is_visible(self, ctx: CurrentUser, dataset_id: UUID) -> bool: ...


class StoragePort(Protocol):
    """Governance only, after it has authorized the download. Signs VERIFIED files of the version; any other
    file id raises CatalogNotFound. URL: NAIS_PUBLIC_BASE_URL, path-style, attachment disposition."""

    def presign_get(
        self, dataset_version_id: UUID, file_ids: Sequence[UUID] | None, ttl_seconds: int
    ) -> list[PresignedGet]: ...


class CatalogReadPort(Protocol):
    """Readiness worker only (D-018): reads bytes with the service credentials, independent of user grants.
    Raises ObjectMissing (404) or StorageUnavailable (connection/timeout/5xx), both defined above."""

    def open_stream(self, file: FileRef, byte_range: tuple[int, int] | None = None) -> BinaryIO: ...


__all__ = [
    "AccessLevel",
    "CatalogNotFound",
    "CatalogQueryPort",
    "CatalogReadPort",
    "DatasetPolicyView",
    "FileRef",
    "ObjectMissing",
    "PresignedGet",
    "StoragePort",
    "StorageUnavailable",
    "VersionView",
]
