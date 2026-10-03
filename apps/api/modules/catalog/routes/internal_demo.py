"""/internal/demo/datasets* (openapi tag `Internal`, D-049): the mock-mode web server's demo catalogue search.

Server-to-server only (X-NAIS-Internal-Token, see api.platform.internal_auth). The demo documents live in their own
index; the real catalog, its index and its database are not touched.
"""

from datetime import date
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field

from api.modules.catalog.deps import CatalogDepsDep
from api.modules.catalog.schemas import AccessLevelIn, PurposeIn, ReadinessIn, SortIn
from api.modules.catalog.search.query import SearchParams
from api.modules.catalog.service import demo as service
from api.platform.internal_auth import body_schema, check_internal_token, read_body
from api.platform.pagination import MAX_CURSOR_LENGTH


def require_internal_token(
    deps: CatalogDepsDep,
    token: Annotated[str | None, Header(alias="X-NAIS-Internal-Token", include_in_schema=False)] = None,
) -> None:
    check_internal_token(deps.settings.nais_internal_token, token)


router = APIRouter(tags=["Internal"], dependencies=[Depends(require_internal_token)])


class DemoDatasetsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    documents: list[dict[str, Any]] = Field(max_length=service.MAX_DEMO_DOCUMENTS)


class DemoViewerIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    organization_id: UUID
    platform_admin: bool = False


class DemoDatasetSearchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    viewer: DemoViewerIn
    q: str | None = Field(default=None, max_length=500)
    access_level: list[AccessLevelIn] = []
    owner_organization_id: list[UUID] = []
    purpose: list[PurposeIn] = []
    keyword: list[str] = []
    readiness_status: list[ReadinessIn] = []
    subject: list[str] = []
    material: list[str] = []
    method: list[str] = []
    collecting_organization_id: list[UUID] = []
    principal_investigator_id: UUID | None = None
    temporal_from: date | None = None
    temporal_to: date | None = None
    sort: SortIn = "relevance"
    cursor: str | None = Field(default=None, max_length=MAX_CURSOR_LENGTH)
    limit: int = Field(default=20, ge=1, le=100)


@router.put(
    "/internal/demo/datasets", operation_id="syncDemoDatasets", openapi_extra=body_schema(DemoDatasetsIn)
)
async def sync_demo_datasets(request: Request, deps: CatalogDepsDep) -> dict[str, int]:
    body = await read_body(request, DemoDatasetsIn)
    # Embedding a catalogue takes a moment: keep the event loop free.
    return await run_in_threadpool(service.sync_demo_datasets, deps, body.documents)


@router.post(
    "/internal/demo/datasets/search",
    operation_id="searchDemoDatasets",
    openapi_extra=body_schema(DemoDatasetSearchIn),
)
async def search_demo_datasets(request: Request, deps: CatalogDepsDep) -> dict[str, Any]:
    body = await read_body(request, DemoDatasetSearchIn)
    params = SearchParams(
        q=body.q,
        access_level=tuple(body.access_level),
        owner_organization_id=tuple(body.owner_organization_id),
        purpose=tuple(body.purpose),
        keyword=tuple(body.keyword),
        readiness_status=tuple(body.readiness_status),
        subject=tuple(body.subject),
        material=tuple(body.material),
        method=tuple(body.method),
        collecting_organization_id=tuple(body.collecting_organization_id),
        principal_investigator_id=body.principal_investigator_id,
        temporal_from=body.temporal_from,
        temporal_to=body.temporal_to,
        sort=body.sort,
        cursor=body.cursor,
        limit=body.limit,
    )
    viewer = service.DemoViewer(body.viewer.organization_id, body.viewer.platform_admin)
    return await run_in_threadpool(service.search_demo_datasets, deps, viewer, params)
