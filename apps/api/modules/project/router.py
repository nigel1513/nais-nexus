"""M02 HTTP surface (openapi tag `projects`). Handlers stay thin: service enforces rules, views shape bodies."""

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends

from api.modules.project import service, views
from api.modules.project.identity import IdentityQueryPort, get_identity_port
from api.modules.project.schemas import ProjectCreateIn
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["projects"])

IdentityDep = Annotated[IdentityQueryPort, Depends(get_identity_port)]


@router.post("/projects", status_code=201, operation_id="createProject")
def create_project(
    body: ProjectCreateIn, user: CurrentUserDep, session: SessionDep, identity: IdentityDep
) -> dict[str, Any]:
    project_id = service.create_project(session, user, body)
    return views.detail_view(session, identity, service.read_project(session, user, project_id))


@router.get("/projects/{project_id}", operation_id="getProject")
def get_project(
    project_id: UUID, user: CurrentUserDep, session: SessionDep, identity: IdentityDep
) -> dict[str, Any]:
    return views.detail_view(session, identity, service.read_project(session, user, project_id))
