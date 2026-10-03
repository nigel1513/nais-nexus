"""Ports the workspace consumes beyond the provider-owned public ones.

Provider ports used as-is (looked up per call through deps.WorkspaceDeps, so wiring order does not matter):
ProjectQueryPort (api.modules.project.public) and CatalogQueryPort (api.modules.catalog.public).
The Protocols below are consumer-side because their provider does not exist yet (grants) or because the
workspace needs only a sliver of the provider port (display names, organization codes), or because the provider is
infrastructure (object storage). Implementations live in adapters/ and storage.py.
"""

from collections.abc import Sequence
from typing import Protocol
from uuid import UUID


class GrantQueryPort(Protocol):
    """Does the user hold an ACTIVE access grant on the dataset?

    There is no governance (M04) backend yet: wiring installs adapters.grants.NoGrants, which answers False
    (fail closed), so only PUBLIC datasets and the owner organization's own datasets are usable. When M04
    ships, wiring.build_default_deps() swaps in an adapter over M04's public port; nothing else changes.
    """

    def has_active_grant(self, user_id: UUID, dataset_id: UUID) -> bool: ...


class DisplayNameLookup(Protocol):
    """user_id -> display name (M01 public profiles), organization_id -> name / code (M01 organization summaries).
    Unknown ids are left out of the result (None for a single lookup)."""

    def get_display_names(self, user_ids: Sequence[UUID]) -> dict[UUID, str]: ...
    def get_organization_names(self, organization_ids: Sequence[UUID]) -> dict[UUID, str]: ...
    def get_organization_code(self, organization_id: UUID) -> str | None: ...


class OutputStorage(Protocol):
    """Objects of project outputs in an organization's bucket (org code -> STORAGE_<CODE>_*, D-024).

    Presigned URLs are for browsers (public gateway); head/sha256 run server-side. Unconfigured storage or an
    unreachable store raises ApiError DEPENDENCY_UNAVAILABLE (503).
    """

    def presign_put(
        self, org_code: str, key: str, content_type: str, sha256_hex: str, ttl: int
    ) -> tuple[str, dict[str, str]]:
        """(url, headers the client must send with the PUT)."""
        ...

    def head(self, org_code: str, key: str) -> int | None:
        """Stored size in bytes, None when the object does not exist."""
        ...

    def sha256(self, org_code: str, key: str) -> str | None:
        """Hex sha256 of the stored object, streamed in bounded chunks; None when it does not exist."""
        ...

    def presign_get(self, org_code: str, key: str, filename: str, ttl: int) -> str: ...

    def put_file(self, org_code: str, key: str, path: str, content_type: str) -> None:
        """Server-side upload of a local file (recipe run results), streamed/multipart by the client."""
        ...
