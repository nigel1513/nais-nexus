"""Recipe runs: POST /projects/{p}/recipes/{r}/runs, GET /projects/{p}/runs[/{run_id}] (openapi tag `workspace`)."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from api.modules.workspace.deps import WorkspaceDepsDep
from api.modules.workspace.schemas import Run, RunStatus
from api.modules.workspace.service import runs as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep
from api.platform.pagination import Page, PageParams, page_params

router = APIRouter(tags=["workspace"])
PageDep = Annotated[PageParams, Depends(page_params)]


@router.post("/projects/{project_id}/recipes/{recipe_id}/runs", operation_id="startRun", status_code=202)
def start_run(
    project_id: UUID, recipe_id: UUID, user: CurrentUserDep, session: SessionDep, deps: WorkspaceDepsDep
) -> Run:
    return service.start_run(session, deps, user, project_id, recipe_id)


@router.get("/projects/{project_id}/runs", operation_id="listRuns")
def list_runs(
    project_id: UUID,
    user: CurrentUserDep,
    session: SessionDep,
    deps: WorkspaceDepsDep,
    paging: PageDep,
    recipe_id: UUID | None = None,
    status: Annotated[list[RunStatus] | None, Query()] = None,
) -> Page[Run]:
    return service.list_runs(
        session,
        deps,
        user,
        project_id,
        recipe_id=recipe_id,
        statuses=[s.value for s in status] if status else None,
        params=paging,
    )


@router.get("/projects/{project_id}/runs/{run_id}", operation_id="getRun")
def get_run(
    project_id: UUID, run_id: UUID, user: CurrentUserDep, session: SessionDep, deps: WorkspaceDepsDep
) -> Run:
    return service.get_run(session, deps, user, project_id, run_id)
