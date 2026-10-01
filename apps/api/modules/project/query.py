"""SqlProjectQueryPort: read-only implementation of ProjectQueryPort, one short session per call."""

from uuid import UUID

from nais_contracts.api_models import ProjectSummary
from sqlalchemy.orm import Session

from api.modules.project import repository as repo
from api.modules.project.public import ProjectQueryPort
from api.modules.project.views import summary_view
from api.platform import ports
from api.platform.db import session_factory


class SqlProjectQueryPort:
    def __init__(self, database_url: str | None = None) -> None:
        self._database_url = database_url  # None -> platform settings DATABASE_URL at call time

    def _session(self) -> Session:
        return session_factory(self._database_url)()

    def is_active_member(self, project_id: UUID, user_id: UUID) -> bool:
        with self._session() as session:
            return repo.is_active_member(session, project_id, user_id)

    def get_member_role(self, project_id: UUID, user_id: UUID) -> str | None:
        with self._session() as session:
            return repo.member_role(session, project_id, user_id)

    def get_summary(self, project_id: UUID) -> ProjectSummary | None:
        with self._session() as session:
            project = repo.get_project(session, project_id)
            if project is None:
                return None
            count = repo.count_active_members(session, project_id)
        return ProjectSummary.model_validate(summary_view(project, my_role=None, member_count=count))

    def list_active_member_ids(self, project_id: UUID) -> list[UUID]:
        with self._session() as session:
            return [member["user_id"] for member in repo.list_active_members(session, project_id)]

    def list_project_ids_for_member(self, user_id: UUID) -> list[UUID]:
        with self._session() as session:
            return repo.project_ids_for_member(session, user_id)


def wire() -> None:
    ports.provide(ProjectQueryPort, SqlProjectQueryPort())
