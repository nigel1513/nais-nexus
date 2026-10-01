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


class OrganizationLookup(Protocol):
    """M03 §3.1 IdentityPort. The organization code selects the storage (STORAGE_<CODE>_*, D-024)."""

    def get_organization_summary(self, organization_id: UUID) -> OrganizationSummary | None: ...
    def get_organization_summaries(self, ids: Sequence[UUID]) -> dict[UUID, OrganizationSummary]: ...


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
    def create_index(self, name: str) -> None: ...
    def next_index_name(self) -> str: ...
    def swap_alias(self, new_index: str) -> list[str]: ...
