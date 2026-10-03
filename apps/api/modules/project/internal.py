"""/internal/demo/projects* (openapi tag `Internal`, D-049): the mock-mode web server's demo project search.

Server-to-server only (X-NAIS-Internal-Token, see api.platform.internal_auth). The demo documents live in their own
index (alias nais-demo-projects) and carry the public summary fields only; the real index and the database are not
touched.
"""

from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field

from api.modules.project.query import get_demo_project_search
from api.modules.project.search import ProjectSearch, replace_documents, search_public_project_ids
from api.modules.project.settings import ProjectSettings, get_project_settings
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.internal_auth import body_schema, check_internal_token, read_body
from api.platform.search_index import SearchRejected, SearchUnavailable

MAX_DEMO_DOCUMENTS = 2000


def require_internal_token(
    settings: Annotated[ProjectSettings, Depends(get_project_settings)],
    token: Annotated[str | None, Header(alias="X-NAIS-Internal-Token", include_in_schema=False)] = None,
) -> None:
    check_internal_token(settings.nais_internal_token, token)


router = APIRouter(tags=["Internal"], dependencies=[Depends(require_internal_token)])


class DemoProjectIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: UUID
    name: str = Field(min_length=1, max_length=200)
    lead_organization_id: UUID
    lead_organization_name: str = ""
    member_count: int = Field(default=0, ge=0)
    updated_at: datetime


class DemoProjectsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    documents: list[DemoProjectIn] = Field(max_length=MAX_DEMO_DOCUMENTS)


class DemoProjectSearchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    q: str = Field(min_length=1, max_length=200)
    limit: int = Field(default=20, ge=1, le=100)


def _search() -> ProjectSearch:
    search = get_demo_project_search()
    if search is None:
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Demo search index is not configured.")
    return search


def _sync(documents: list[DemoProjectIn]) -> dict[str, int]:
    try:
        written, removed = replace_documents(_search(), [doc.model_dump(mode="json") for doc in documents])
    except SearchUnavailable as exc:
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Demo search index is unavailable.") from exc
    return {"indexed": written, "removed": removed}


def _find(q: str, limit: int) -> dict[str, list[str]]:
    try:
        ids = search_public_project_ids(_search(), q, limit=limit)
    except (SearchUnavailable, SearchRejected) as exc:
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Demo search index is unavailable.") from exc
    return {"project_ids": [str(project_id) for project_id in ids]}


@router.put(
    "/internal/demo/projects", operation_id="syncDemoProjects", openapi_extra=body_schema(DemoProjectsIn)
)
async def sync_demo_projects(request: Request) -> dict[str, int]:
    body = await read_body(request, DemoProjectsIn)
    return await run_in_threadpool(_sync, body.documents)


@router.post(
    "/internal/demo/projects/search",
    operation_id="searchDemoProjects",
    openapi_extra=body_schema(DemoProjectSearchIn),
)
async def search_demo_projects(request: Request) -> dict[str, list[str]]:
    body = await read_body(request, DemoProjectSearchIn)
    return await run_in_threadpool(_find, body.q.strip(), body.limit)
