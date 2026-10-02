"""Hub publication: POST /projects/{p}/outputs/{o}/publish-requests, GET /publish-requests,
POST /publish-requests/{request_id}/decision (openapi tag `workspace`)."""

from enum import StrEnum
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Query

from api.modules.workspace.deps import WorkspaceDepsDep
from api.modules.workspace.schemas import (
    PublishDecisionIn,
    PublishRequest,
    PublishRequestIn,
    PublishRequestStatus,
)
from api.modules.workspace.service import publish as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep
from api.platform.pagination import Page, PageParams, page_params

router = APIRouter(tags=["workspace"])
PageDep = Annotated[PageParams, Depends(page_params)]


class ListRole(StrEnum):
    requester = "requester"
    reviewer = "reviewer"


@router.post(
    "/projects/{project_id}/outputs/{output_id}/publish-requests",
    operation_id="requestOutputPublish",
    status_code=201,
)
def request_output_publish(
    project_id: UUID,
    output_id: UUID,
    user: CurrentUserDep,
    session: SessionDep,
    deps: WorkspaceDepsDep,
    body: Annotated[PublishRequestIn | None, Body()] = None,
) -> PublishRequest:
    return service.request_publish(session, deps, user, project_id, output_id, body)


@router.get("/publish-requests", operation_id="listPublishRequests")
def list_publish_requests(
    user: CurrentUserDep,
    session: SessionDep,
    deps: WorkspaceDepsDep,
    paging: PageDep,
    role: ListRole = ListRole.requester,
    status: Annotated[list[PublishRequestStatus] | None, Query()] = None,
    project_id: UUID | None = None,
) -> Page[PublishRequest]:
    return service.list_requests(
        session,
        deps,
        user,
        role=role.value,
        statuses=[s.value for s in status] if status else None,
        project_id=project_id,
        params=paging,
    )


@router.post("/publish-requests/{request_id}/decision", operation_id="decidePublishRequest")
def decide_publish_request(
    request_id: UUID,
    body: PublishDecisionIn,
    user: CurrentUserDep,
    session: SessionDep,
    deps: WorkspaceDepsDep,
) -> PublishRequest:
    return service.decide(session, deps, user, request_id, body)
