"""ReadinessQueryPort (M05 §8): latest COMPLETED overall per version/profile, for other modules (P1 M06).

Leaf module (D-038): the Protocol is the registry key; the provider lives in query.py."""

from typing import Literal, Protocol
from uuid import UUID

OverallStatus = Literal["PASS", "WARNING", "FAIL"]


class ReadinessQueryPort(Protocol):
    def get_latest_overall(self, dataset_version_id: UUID, profile_id: str) -> OverallStatus | None: ...
