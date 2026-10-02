"""Ports the notes module consumes beyond the provider-owned public ones.

ProjectQueryPort (api.modules.project.public) is used as-is, looked up per call through deps.NotesDeps so wiring order
does not matter. DisplayNameLookup is consumer-side because notes need only a sliver of M01's IdentityQueryPort;
its implementation is adapters.IdentityDisplayNames.

NotebookActivityPort is the drafting source: the Jupyter notebooks (M07, built after the notes module) a researcher
saved on a day. Until M07 provides it (ports.provide(NotebookActivityPort, ...)) the default adapters.NoNotebooks
answers nothing, so drafting has no source. The port carries cell sources (head only) and output kinds/counts, never
output values or text.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Literal, Protocol
from uuid import UUID


class DisplayNameLookup(Protocol):
    """user_id -> display name / organization, organization_id -> name (M01 public profiles and organization
    summaries). Unknown ids are left out of the result."""

    def get_display_names(self, user_ids: Sequence[UUID]) -> dict[UUID, str]: ...

    def get_organization_ids(self, user_ids: Sequence[UUID]) -> dict[UUID, UUID]: ...

    def get_organization_names(self, organization_ids: Sequence[UUID]) -> dict[UUID, str]: ...


@dataclass(frozen=True)
class NotebookCell:
    type: Literal["code", "markdown"]
    source_head: str
    output_kinds: tuple[str, ...]
    output_count: int
    has_error: bool


@dataclass(frozen=True)
class NotebookActivity:
    notebook_id: UUID
    title: str
    version_id: UUID | None
    saved_at: datetime
    cells: tuple[NotebookCell, ...]


class NotebookActivityPort(Protocol):
    def list_notebook_activity(
        self, user_id: UUID, project_id: UUID | None, day: date
    ) -> list[NotebookActivity]: ...

    def list_notebook_authors(self, day: date) -> list[tuple[UUID, UUID]]:
        """(user_id, project_id) with saved notebooks that day."""
        ...
