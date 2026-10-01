"""M02 public port (M02 §8, D-038). Consumers: `from api.modules.project.public import ProjectQueryPort` then
`api.platform.ports.get(ProjectQueryPort)`. Never query project.* tables directly.
Imports nothing from project internals (only stdlib/typing and the generated contract models)."""

from typing import Protocol
from uuid import UUID

from nais_contracts.api_models import ProjectSummary


class ProjectQueryPort(Protocol):
    def is_active_member(self, project_id: UUID, user_id: UUID) -> bool:
        """True only when project.status == ACTIVE and member.status == ACTIVE (ARCHIVED -> False).
        Governance trusts only this value for project-scoped checks."""
        ...

    def get_member_role(self, project_id: UUID, user_id: UUID) -> str | None: ...

    def get_summary(self, project_id: UUID) -> ProjectSummary | None:
        """openapi ProjectSummary with my_role=None."""
        ...

    def list_active_member_ids(self, project_id: UUID) -> list[UUID]: ...

    def list_project_ids_for_member(self, user_id: UUID) -> list[UUID]:
        """Projects with an ACTIVE membership of this user (any project status)."""
        ...
