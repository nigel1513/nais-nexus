from typing import Any
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Response

from api.modules.catalog.deps import CatalogDepsDep
from api.modules.catalog.schemas import VersionCreateIn, VersionUpdateIn
from api.modules.catalog.service import versions as service
from api.modules.catalog.service.uploads import run_cleanups
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["catalog"])


@router.get("/datasets/{dataset_id}/versions", operation_id="listDatasetVersions")
def list_dataset_versions(dataset_id: UUID, session: SessionDep, user: CurrentUserDep) -> dict[str, Any]:
    return service.list_versions(session, user, dataset_id)


@router.post("/datasets/{dataset_id}/versions", operation_id="createDatasetVersion", status_code=201)
def create_dataset_version(
    dataset_id: UUID, body: VersionCreateIn, session: SessionDep, user: CurrentUserDep
) -> dict[str, Any]:
    return service.create_version(session, user, dataset_id, body)


@router.get("/dataset-versions/{version_id}", operation_id="getDatasetVersion")
def get_dataset_version(version_id: UUID, session: SessionDep, user: CurrentUserDep) -> dict[str, Any]:
    return service.get_version(session, user, version_id)


@router.patch("/dataset-versions/{version_id}", operation_id="updateDatasetVersion")
def update_dataset_version(
    version_id: UUID, body: VersionUpdateIn, session: SessionDep, user: CurrentUserDep
) -> dict[str, Any]:
    return service.update_version(session, user, version_id, body)


@router.delete("/dataset-versions/{version_id}", operation_id="discardDatasetVersion", status_code=204)
def discard_dataset_version(
    version_id: UUID,
    background: BackgroundTasks,
    session: SessionDep,
    user: CurrentUserDep,
    deps: CatalogDepsDep,
) -> Response:
    cleanups = service.discard_version(session, deps, user, version_id)
    if cleanups:
        background.add_task(run_cleanups, deps, cleanups)  # after SessionDep committed
    return Response(status_code=204)
