from typing import Any
from uuid import UUID

from fastapi import APIRouter

from api.modules.catalog.service import publish as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["catalog"])


@router.post("/dataset-versions/{version_id}/publish", operation_id="publishDatasetVersion")
def publish_dataset_version(version_id: UUID, session: SessionDep, user: CurrentUserDep) -> dict[str, Any]:
    return service.publish_version(session, user, version_id)
