from typing import Any
from uuid import UUID

from fastapi import APIRouter

from api.modules.catalog.deps import CatalogDepsDep
from api.modules.catalog.schemas import ContributorsPutIn
from api.modules.catalog.service import contributors as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["catalog"])


@router.get("/datasets/{dataset_id}/contributors", operation_id="listDatasetContributors")
def list_dataset_contributors(
    dataset_id: UUID, session: SessionDep, user: CurrentUserDep, deps: CatalogDepsDep
) -> dict[str, Any]:
    return service.list_contributors(session, deps, user, dataset_id)


@router.put("/datasets/{dataset_id}/contributors", operation_id="putDatasetContributors")
def put_dataset_contributors(
    dataset_id: UUID, body: ContributorsPutIn, session: SessionDep, user: CurrentUserDep, deps: CatalogDepsDep
) -> dict[str, Any]:
    return service.put_contributors(session, deps, user, dataset_id, body)
