from typing import Any
from uuid import UUID

from fastapi import APIRouter

from api.modules.catalog.deps import CatalogDepsDep
from api.modules.catalog.schemas import DatasetUpdateIn
from api.modules.catalog.service import dataset_update as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["catalog"])


@router.patch("/datasets/{dataset_id}", operation_id="updateDataset")
def update_dataset(
    dataset_id: UUID, body: DatasetUpdateIn, session: SessionDep, user: CurrentUserDep, deps: CatalogDepsDep
) -> dict[str, Any]:
    return service.update_dataset(session, deps, user, dataset_id, body)
