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


# The `error` of a FAILED run (Run.error, workspace.run.failed.v1 payload) is exactly one of these codes; readers
# (web, notifications) turn it into a Korean sentence and fall back to a generic one for a code they do not know.
RUN_ERROR_CODES: frozenset[str] = frozenset(
    {
        "RECIPE_MISSING",  # the pinned recipe version is gone
        "INPUT_ACCESS_LAPSED",  # the starter lost access to an input before the run
        "RECIPE_INVALID",  # a step does not fit its input
        "RESULT_TOO_LARGE",  # a step produced more rows than allowed
        "INPUT_UNAVAILABLE",  # a pinned input version is no longer published / its file is gone
        "INPUT_NOT_TABULAR",  # a pinned input has no CSV or Parquet file
        "INPUT_TOO_LARGE",  # an input exceeds the row or byte cap
        "INPUT_UNREADABLE",  # an input file cannot be parsed
        "STORAGE_NOT_CONFIGURED",  # the project's lead organization has no bucket
        "OUT_OF_MEMORY",
        "STORAGE_UNAVAILABLE",  # storage/database outage after every attempt
        "INTERNAL_ERROR",
        "RUN_TIMEOUT",
        "STALE_RUN",  # the sweeper gave up on it
    }
)


class WorkspaceQueryPort(Protocol):
    def list_pinned_inputs(self, project_id: UUID) -> list[PinnedInput]:
        """Live (not removed) inputs of the project, oldest first. No access decision is made here."""
        ...


__all__ = ["RUN_ERROR_CODES", "PinnedInput", "WorkspaceQueryPort"]
