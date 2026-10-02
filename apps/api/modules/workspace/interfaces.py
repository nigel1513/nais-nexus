"""Ports the workspace consumes beyond the provider-owned public ones.

Provider ports used as-is (looked up per call through deps.WorkspaceDeps, so wiring order does not matter):
ProjectQueryPort (api.modules.project.public) and CatalogQueryPort (api.modules.catalog.public).
The Protocols below are consumer-side because their provider does not exist yet (grants) or because the
workspace needs only a sliver of the provider port (display names). Implementations live in adapters/.
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
    """user_id -> display name (M01 public profiles). Unknown ids are left out of the result."""

    def get_display_names(self, user_ids: Sequence[UUID]) -> dict[UUID, str]: ...
