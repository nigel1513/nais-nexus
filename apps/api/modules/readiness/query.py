"""Provider of ReadinessQueryPort (kept out of public.py so consumers do not load jobs/engine/pyarrow)."""

from typing import cast
from uuid import UUID

from sqlalchemy.orm import Session, sessionmaker

from api.modules.readiness import jobs
from api.modules.readiness.public import OverallStatus, ReadinessQueryPort
from api.modules.readiness.service import latest_overall
from api.platform import ports
from api.platform.db import session_factory


class ReadinessQueryService:
    def __init__(self, sessions: sessionmaker[Session]) -> None:
        self._sessions = sessions

    def get_latest_overall(self, dataset_version_id: UUID, profile_id: str) -> OverallStatus | None:
        with self._sessions() as session:
            return cast(OverallStatus | None, latest_overall(session, dataset_version_id, profile_id))


def wire() -> None:
    ports.provide(ReadinessQueryPort, ReadinessQueryService(session_factory(jobs.RUNTIME.database_url)))
