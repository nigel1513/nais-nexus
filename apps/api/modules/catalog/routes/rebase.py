from typing import Any
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks

from api.modules.catalog.deps import CatalogDepsDep
from api.modules.catalog.schemas import RebaseIn
from api.modules.catalog.service import rebase as service
from api.modules.catalog.service.uploads import run_cleanups
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["catalog"])


@router.post("/dataset-versions/{version_id}/rebase", operation_id="rebaseDatasetVersion")
def rebase_dataset_version(
    version_id: UUID,
    background: BackgroundTasks,
    session: SessionDep,
    user: CurrentUserDep,
    deps: CatalogDepsDep,
    body: RebaseIn | None = None,
) -> dict[str, Any]:
    response, cleanups = service.rebase(session, deps, user, version_id, body or RebaseIn())
    if cleanups:
        background.add_task(run_cleanups, deps, cleanups)  # after SessionDep committed
    return response
