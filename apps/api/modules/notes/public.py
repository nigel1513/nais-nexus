"""M14 research-notes public interface. Other modules import only this file; they never read notes.* tables.
Leaf: stdlib/typing only.

NotebookActivityPort is the port notes consume for drafting: M07 (Jupyter) implements it and registers it with
`api.platform.ports.provide(NotebookActivityPort, impl)`. Until then notes use an empty default. The port carries
cell source heads and output kinds/counts only, never output values or text. Everything else notes expose goes
through the HTTP contract and the notes.note.*.v1 events.
"""

from dataclasses import dataclass
from datetime import date, datetime
from typing import Literal, Protocol
from uuid import UUID


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

    def count_notebooks(self, user_id: UUID, project_id: UUID, day: date) -> int:
        """How many notebooks the user saved in the project that day: the cheap check behind draft_source_count and
        the draftNote gate (an implementation may answer from file listings without reading any notebook)."""
        ...


__all__ = ["NotebookActivity", "NotebookActivityPort", "NotebookCell"]
