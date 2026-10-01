from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Query

from api.modules.catalog.deps import CatalogDepsDep
from api.modules.catalog.schemas import AccessLevelIn, PurposeIn, ReadinessIn, SortIn
from api.modules.catalog.search.query import SearchParams
from api.modules.catalog.service import search as service
from api.platform.auth import CurrentUserDep
from api.platform.pagination import MAX_CURSOR_LENGTH

router = APIRouter(tags=["catalog"])


@router.get("/datasets", operation_id="searchDatasets")
def search_datasets(
    user: CurrentUserDep,
    deps: CatalogDepsDep,
    q: Annotated[str | None, Query(max_length=500)] = None,
    access_level: Annotated[list[AccessLevelIn] | None, Query()] = None,
    owner_organization_id: Annotated[list[UUID] | None, Query()] = None,
    purpose: Annotated[list[PurposeIn] | None, Query()] = None,
    keyword: Annotated[list[str] | None, Query()] = None,
    readiness_status: Annotated[list[ReadinessIn] | None, Query()] = None,
    sort: SortIn = "relevance",
    cursor: Annotated[str | None, Query(max_length=MAX_CURSOR_LENGTH)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> dict[str, Any]:
    params = SearchParams(
        q=q,
        access_level=tuple(access_level or ()),
        owner_organization_id=tuple(owner_organization_id or ()),
        purpose=tuple(purpose or ()),
        keyword=tuple(keyword or ()),
        readiness_status=tuple(readiness_status or ()),
        sort=sort,
        cursor=cursor,
        limit=limit,
    )
    return service.search_datasets(deps, user, params)
