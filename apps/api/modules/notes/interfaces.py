"""Ports the notes module consumes beyond the provider-owned public ones.

ProjectQueryPort (api.modules.project.public) is used as-is, looked up per call through deps.NotesDeps so wiring order
does not matter. DisplayNameLookup is consumer-side because notes need only a sliver of M01's IdentityQueryPort;
its implementation is adapters.IdentityDisplayNames.
"""

from collections.abc import Sequence
from typing import Protocol
from uuid import UUID


class DisplayNameLookup(Protocol):
    """user_id -> display name (M01 public profiles). Unknown ids are left out of the result."""

    def get_display_names(self, user_ids: Sequence[UUID]) -> dict[UUID, str]: ...
