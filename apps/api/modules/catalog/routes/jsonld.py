from uuid import UUID

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from api.modules.catalog.access import visible_dataset
from api.modules.catalog.deps import CatalogDepsDep
from api.modules.catalog.jsonld import dataset_jsonld
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["catalog"])


@router.get("/datasets/{dataset_id}/metadata.jsonld", operation_id="getDatasetJsonLd")
def get_dataset_jsonld(
    dataset_id: UUID, session: SessionDep, user: CurrentUserDep, deps: CatalogDepsDep
) -> JSONResponse:
    ds = visible_dataset(session, user, dataset_id)
    return JSONResponse(dataset_jsonld(session, deps, ds), media_type="application/ld+json")
