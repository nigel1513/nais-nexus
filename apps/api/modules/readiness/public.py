"""ReadinessQueryPort (M05 §8): latest COMPLETED overall per version/profile, for other modules (P1 M06)."""

from typing import Literal, Protocol, cast
from uuid import UUID

from api.modules.readiness import jobs
from api.modules.readiness.service import latest_overall
from api.platform import ports
from api.platform.db import session_factory

OverallStatus = Literal["PASS", "WARNING", "FAIL"]


class ReadinessQueryPort(Protocol):
    def get_latest_overall(self, dataset_version_id: UUID, profile_id: str) -> OverallStatus | None: ...


class ReadinessQueryService:
    def get_latest_overall(self, dataset_version_id: UUID, profile_id: str) -> OverallStatus | None:
        with session_factory(jobs.RUNTIME.database_url)() as session:
            return cast(OverallStatus | None, latest_overall(session, dataset_version_id, profile_id))


def wire() -> None:
    ports.provide(ReadinessQueryPort, ReadinessQueryService())
