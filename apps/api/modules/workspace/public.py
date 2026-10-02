"""M13 workspace public interface. Other modules import only this file and look the implementation up with
api.platform.ports.get(WorkspaceQueryPort); they never read workspace.* tables. Leaf: stdlib/typing only."""

from dataclasses import dataclass
from typing import Protocol
from uuid import UUID


@dataclass(frozen=True)
class PinnedInput:
    input_id: UUID
    project_id: UUID
    dataset_id: UUID
    dataset_version_id: UUID


class WorkspaceQueryPort(Protocol):
    def list_pinned_inputs(self, project_id: UUID) -> list[PinnedInput]:
        """Live (not removed) inputs of the project, oldest first. No access decision is made here."""
        ...


__all__ = ["PinnedInput", "WorkspaceQueryPort"]
