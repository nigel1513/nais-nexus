"""Ports the catalog consumes (M03 §3.1) and internal seams. Implementations: adapters/, objects.py, search/."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol
from uuid import UUID


@dataclass(frozen=True)
class OrganizationSummary:
    organization_id: UUID
    code: str
    name: str
    type: str


@dataclass(frozen=True)
class PersonSummary:
    user_id: UUID
    display_name: str
    organization_id: UUID
    organization_name: str | None
    status: str  # ACTIVE only when user and current membership are both ACTIVE
    national_researcher_number: str | None = None


class OrganizationLookup(Protocol):
    """M03 §3.1 IdentityPort. The organization code selects the storage (STORAGE_<CODE>_*, D-024); persons come from
    M01's public profiles (Wave 1.5 research metadata)."""

    def get_organization_summary(self, organization_id: UUID) -> OrganizationSummary | None: ...
    def get_organization_summaries(self, ids: Sequence[UUID]) -> dict[UUID, OrganizationSummary]: ...
    def get_people(self, ids: Sequence[UUID]) -> dict[UUID, PersonSummary]: ...
    def get_email(self, user_id: UUID) -> str | None: ...


ScanStatus = Literal["CLEAN", "INFECTED", "SKIPPED"]


@dataclass(frozen=True)
class ScanResult:
    status: ScanStatus
    detail: str | None = None


class MalwareScannerPort(Protocol):
    def scan(self, bucket: str, key: str) -> ScanResult: ...


class VerificationQueue(Protocol):
    """Schedules asynchronous verification (catalog.verify_file). Call only after the DB commit."""

    def enqueue(self, file_ids: Sequence[UUID]) -> None: ...


class SearchIndex(Protocol):
    alias: str

    def ensure(self) -> None: ...
    def bulk(
        self, upserts: Sequence[Mapping[Any, Any]], deletes: Sequence[str], *, index: str | None = None
    ) -> None: ...
    def search(self, body: Mapping[Any, Any]) -> dict[str, Any]: ...
    def refresh(self) -> None: ...
    def create_index(self, name: str, *, exist_ok: bool = True) -> None: ...
    def next_index_name(self) -> str: ...
    def swap_alias(self, new_index: str) -> list[str]: ...
    def supports_vectors(self, index: str | None = None) -> bool: ...


class PreviewGrantLookup(Protocol):
    """M04 (Wave 2) answers whether the user holds an ACTIVE grant on the dataset (Data Explorer preview)."""

    def has_active_grant(self, user_id: UUID, dataset_id: UUID) -> bool: ...
