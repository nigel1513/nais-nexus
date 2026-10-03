from typing import Any
from uuid import UUID

from fastapi import APIRouter

from api.modules.catalog.deps import CatalogDepsDep
from api.modules.catalog.service import diff as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["catalog"])


@router.get("/dataset-versions/{version_id}/diff", operation_id="compareDatasetVersions")
def compare_dataset_versions(
    version_id: UUID,
    session: SessionDep,
    user: CurrentUserDep,
    deps: CatalogDepsDep,
    against: UUID | None = None,
) -> dict[str, Any]:
    return service.compare(session, deps, user, version_id, against)
