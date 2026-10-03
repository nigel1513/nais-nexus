"""SqlProjectQueryPort: read-only implementation of ProjectQueryPort, one short session per call."""

from dataclasses import dataclass
from uuid import UUID

from nais_contracts.api_models import ProjectSummary
from sqlalchemy.orm import Session

from api.modules.project import repository as repo
from api.modules.project.public import ProjectQueryPort
from api.modules.project.search import ProjectSearch, project_index
from api.modules.project.settings import ProjectSettings, get_project_settings
from api.modules.project.views import summary_view
from api.platform import ports
from api.platform.db import session_factory
from api.platform.llm import get_embedding_client


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


@dataclass(frozen=True)
class ProjectSearchSlot:
    """The public project index of this process, or None when OPENSEARCH_URL is not configured."""

    search: ProjectSearch | None


def build_project_search(settings: ProjectSettings | None = None) -> ProjectSearch | None:
    settings = settings or get_project_settings()
    if not settings.opensearch_url:
        return None
    return ProjectSearch(
        index=project_index(
            settings.opensearch_url,
            settings.project_index_alias,
            timeout=settings.project_opensearch_timeout_seconds,
        ),
        embedder=get_embedding_client(),
        query_embedder=get_embedding_client(settings.project_embed_query_timeout_seconds),
        semantic_min_score=settings.project_semantic_min_score,
    )


def get_project_search() -> ProjectSearch | None:
    try:
        return ports.get(ProjectSearchSlot).search
    except ports.PortNotProvided:
        return None


def wire() -> None:
    ports.provide(ProjectQueryPort, SqlProjectQueryPort())
    ports.provide(ProjectSearchSlot, ProjectSearchSlot(build_project_search()))
