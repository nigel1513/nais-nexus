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
class DatasetSummary:
    """Card-level facts for the M13 Data-Hub (no data values). subject_labels: Korean SUBJECT labels in code order."""

    dataset_id: UUID
    title: str
    owner_organization_id: UUID
    owner_organization_name: str  # "" when the organization is unknown
    access_level: AccessLevel
    status: Literal["ACTIVE", "WITHDRAWN"]
    subject_labels: tuple[str, ...]
    readiness_overall: str | None  # latest PUBLISHED version, D-028 primary profile rule
    updated_at: datetime
    latest_published_at: datetime | None


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


# Why CatalogPublishPort refused a publication for good (CatalogPublishRejected.code). Callers show their own sentence
# per code; the English detail is for logs only.
PUBLISH_REJECTION_CODES: frozenset[str] = frozenset(
    {
        "NO_FILES",  # the output has no file
        "TOO_MANY_FILES",
        "FILE_TYPE_NOT_ALLOWED",
        "FILE_TOO_LARGE",
        "EMPTY_FILE",
        "INVALID_PATH",  # an unsafe or duplicate manifest path
        "STORAGE_NOT_CONFIGURED",  # the owner organization has no storage
        "STORAGE_MISMATCH",  # the source objects are outside the owner's storage
        "INVALID_POLICY",
        "DATASET_ID_CONFLICT",  # dataset_id is already used by another dataset
        "ACCESS_LEVEL_TIGHTENED",  # a resume asks for a stricter level than the draft dataset's
        "VERSION_UNAVAILABLE",  # v1 is neither DRAFT nor PUBLISHED (withdrawn)
        "FILES_CHANGED",  # the files differ from the ones the dataset was created with
        "DATASET_WITHDRAWN",  # the dataset was withdrawn before v1 was published
    }
)


class CatalogPublishRejected(ValueError):  # noqa: N818
    """CatalogPublishPort: the request can never succeed as given (files break the upload rules, the owner organization
    has no storage, the source objects are outside the owner's storage, or dataset_id is already used otherwise).
    `code` is one of PUBLISH_REJECTION_CODES; `detail` is English for logs."""

    def __init__(self, code: str, detail: str = "") -> None:
        if code not in PUBLISH_REJECTION_CODES:
            raise ValueError(f"unknown publish rejection code {code!r}")
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class OutputFileSource:
    """A stored M13 output object to copy into a new dataset version. storage_* are internal only (never in API
    responses, events or logs)."""

    path: str  # manifest path in the new version
    size_bytes: int
    sha256: str  # hex
    media_type: str
    storage_org_code: str  # organization whose bucket holds the object (must be the new dataset's owner)
    storage_key: str


@dataclass(frozen=True)
class OutputDatasetState:
    """Where a dataset created from an output stands. DRAFT: files are still being verified (call again later);
    PUBLISHED: version v1 is published through the normal publish path; FAILED: a file failed verification, so the
    version can never be published as given."""

    dataset_id: UUID
    dataset_version_id: UUID
    status: Literal["DRAFT", "PUBLISHED", "FAILED"]


class CatalogQueryPort(Protocol):
    """For Governance (M04) and Readiness (M05). Makes no access decision except is_visible (D-012)."""

    def get_policy_view(self, dataset_id: UUID) -> DatasetPolicyView | None: ...
    def get_version(self, dataset_version_id: UUID) -> VersionView | None: ...
    def get_latest_published_version(self, dataset_id: UUID) -> VersionView | None:
        """Most recently published PUBLISHED version of the dataset (M13 newer_version_label, default input version)."""
        ...

    def is_visible(self, ctx: CurrentUser, dataset_id: UUID) -> bool: ...
    def list_visible_dataset_summaries(self, ctx: CurrentUser) -> list[DatasetSummary]:
        """Every dataset is_visible(ctx, ...) would accept (D-012, WITHDRAWN included for the owner), batched."""
        ...


class StoragePort(Protocol):
    """Governance only, after it has authorized the download. Signs VERIFIED files of the version; any other
    file id raises CatalogNotFound. URL: NAIS_PUBLIC_BASE_URL, path-style, attachment disposition."""

    def presign_get(
        self, dataset_version_id: UUID, file_ids: Sequence[UUID] | None, ttl_seconds: int
    ) -> list[PresignedGet]: ...


class CatalogReadPort(Protocol):
    """Readiness worker (D-018) and M13 workspace recipe previews/runs: reads bytes with the service credentials,
    independent of user grants (the workspace checks the caller's dataset access before every read).
    The FileRef is re-verified against the catalog (VERIFIED file of a PUBLISHED version, same bucket/key),
    otherwise ObjectMissing; byte_range must satisfy 0 <= start <= end (ValueError). Raises ObjectMissing (404) or StorageUnavailable (connection/timeout/5xx), both defined above."""

    def open_stream(self, file: FileRef, byte_range: tuple[int, int] | None = None) -> BinaryIO: ...


class CatalogPublishPort(Protocol):
    """M13 workspace: an output approved by the owner organizations of its inputs becomes a catalog dataset.
    The workspace has decided the approval; the catalog applies its own rules (upload allow list, verification,
    publish requires every file VERIFIED). Makes no other access decision."""

    def output_file_problems(self, files: Sequence[OutputFileSource]) -> list[dict[str, str]]:
        """The catalog upload rules each file breaks, as [{"path", "reason"}] (reason: a path problem code,
        FILE_TYPE_NOT_ALLOWED, FILE_TOO_LARGE, DUPLICATE_PATH or TOO_MANY_FILES); [] when all are acceptable."""
        ...

    def create_dataset_from_output(
        self,
        *,
        dataset_id: UUID,
        owner_organization_id: UUID,
        title: str,
        description: str,
        access_level: AccessLevel,
        allowed_purposes: Sequence[str],
        files: Sequence[OutputFileSource],
        lineage_note: str,
        created_by: UUID,
        published_by: UUID,
        publisher_organization_id: UUID | None,
    ) -> OutputDatasetState:
        """Idempotent on dataset_id (call again with the same arguments to resume): creates the dataset (provenance =
        lineage_note) and DRAFT version v1, copies the objects server-side into the catalog's upload layout, runs the
        normal verification (synchronous for small files, the verify queue otherwise) and publishes v1 through the
        normal publish path once every file is VERIFIED. Raises CatalogPublishRejected (permanent) or
        StorageUnavailable (retry later)."""
        ...


__all__ = [
    "AccessLevel",
    "CatalogNotFound",
    "CatalogPublishPort",
    "CatalogPublishRejected",
    "PUBLISH_REJECTION_CODES",
    "CatalogQueryPort",
    "CatalogReadPort",
    "DatasetPolicyView",
    "DatasetSummary",
    "FileRef",
    "ObjectMissing",
    "OutputDatasetState",
    "OutputFileSource",
    "PresignedGet",
    "StoragePort",
    "StorageUnavailable",
    "VersionView",
]
