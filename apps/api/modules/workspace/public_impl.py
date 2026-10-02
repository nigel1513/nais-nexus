"""Implementation of WorkspaceQueryPort (registered by wiring.install); one short session per call."""

from uuid import UUID

from sqlalchemy.orm import Session

from api.modules.workspace import repo
from api.modules.workspace.public import PinnedInput
from api.platform.db import session_factory


class SqlWorkspaceQuery:
    def __init__(self, database_url: str | None = None) -> None:
        self._database_url = database_url  # None -> platform settings DATABASE_URL at call time

    def _session(self) -> Session:
        return session_factory(self._database_url)()

    def list_pinned_inputs(self, project_id: UUID) -> list[PinnedInput]:
        with self._session() as session:
            rows = repo.live_inputs(session, project_id)
        return [
            PinnedInput(
                input_id=r["input_id"],
                project_id=r["project_id"],
                dataset_id=r["dataset_id"],
                dataset_version_id=r["dataset_version_id"],
            )
            for r in rows
        ]
