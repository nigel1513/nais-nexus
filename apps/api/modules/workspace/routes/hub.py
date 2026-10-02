"""Data-Hub reads: /hub/overview, /datasets/{dataset_id}/projects, /datasets/{dataset_id}/activity (tag `hub`)."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends

from api.modules.workspace.deps import WorkspaceDepsDep
from api.modules.workspace.schemas import DatasetActivity, DatasetProjectsResult, HubOverview
from api.modules.workspace.service import hub as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep
from api.platform.pagination import Page, PageParams, page_params

router = APIRouter(tags=["hub"])
PageDep = Annotated[PageParams, Depends(page_params)]


@router.get("/hub/overview", operation_id="getHubOverview")
def get_hub_overview(user: CurrentUserDep, session: SessionDep, deps: WorkspaceDepsDep) -> HubOverview:
    return service.overview(session, deps, user)


@router.get("/datasets/{dataset_id}/projects", operation_id="listDatasetProjects")
def list_dataset_projects(
    dataset_id: UUID, user: CurrentUserDep, session: SessionDep, deps: WorkspaceDepsDep
) -> DatasetProjectsResult:
    return service.dataset_projects(session, deps, user, dataset_id)


@router.get("/datasets/{dataset_id}/activity", operation_id="listDatasetActivity")
def list_dataset_activity(
    dataset_id: UUID, user: CurrentUserDep, session: SessionDep, deps: WorkspaceDepsDep, paging: PageDep
) -> Page[DatasetActivity]:
    return service.dataset_activity(session, deps, user, dataset_id, paging)
