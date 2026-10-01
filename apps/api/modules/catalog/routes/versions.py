from typing import Any
from uuid import UUID

from fastapi import APIRouter

from api.modules.catalog.schemas import VersionCreateIn
from api.modules.catalog.service import versions as service
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
