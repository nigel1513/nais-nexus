from typing import Any
from uuid import UUID

from fastapi import APIRouter

from api.modules.catalog.deps import CatalogDepsDep
from api.modules.catalog.schemas import DatasetCreateIn
from api.modules.catalog.service import datasets as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["catalog"])


@router.post("/datasets", operation_id="createDataset", status_code=201)
def create_dataset(
    body: DatasetCreateIn, session: SessionDep, user: CurrentUserDep, deps: CatalogDepsDep
) -> dict[str, Any]:
    return service.create_dataset(session, deps, user, body)


@router.get("/datasets/{dataset_id}", operation_id="getDataset")
def get_dataset(
    dataset_id: UUID, session: SessionDep, user: CurrentUserDep, deps: CatalogDepsDep
) -> dict[str, Any]:
    return service.get_dataset(session, deps, user, dataset_id)


@router.get("/datasets/{dataset_id}/policy", operation_id="getDatasetPolicy")
def get_dataset_policy(dataset_id: UUID, session: SessionDep, user: CurrentUserDep) -> dict[str, Any]:
    return service.get_policy(session, user, dataset_id)
