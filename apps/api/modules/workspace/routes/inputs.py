"""Pinned dataset inputs: /projects/{project_id}/inputs (openapi tag `workspace`)."""

from uuid import UUID

from fastapi import APIRouter, Response

from api.modules.workspace.deps import WorkspaceDepsDep
from api.modules.workspace.schemas import InputCreateIn, InputUpdateIn, ProjectInput, ProjectInputList
from api.modules.workspace.service import inputs as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["workspace"])


@router.get("/projects/{project_id}/inputs", operation_id="listProjectInputs")
def list_project_inputs(
    project_id: UUID, user: CurrentUserDep, session: SessionDep, deps: WorkspaceDepsDep
) -> ProjectInputList:
    return ProjectInputList(items=service.list_inputs(session, deps, user, project_id))


@router.post("/projects/{project_id}/inputs", operation_id="addProjectInput", status_code=201)
def add_project_input(
    project_id: UUID, body: InputCreateIn, user: CurrentUserDep, session: SessionDep, deps: WorkspaceDepsDep
) -> ProjectInput:
    return service.add_input(session, deps, user, project_id, body)


@router.patch("/projects/{project_id}/inputs/{input_id}", operation_id="updateProjectInput")
def update_project_input(
    project_id: UUID,
    input_id: UUID,
    body: InputUpdateIn,
    user: CurrentUserDep,
    session: SessionDep,
    deps: WorkspaceDepsDep,
) -> ProjectInput:
    return service.update_input(session, deps, user, project_id, input_id, body)


@router.delete("/projects/{project_id}/inputs/{input_id}", operation_id="removeProjectInput", status_code=204)
def remove_project_input(
    project_id: UUID, input_id: UUID, user: CurrentUserDep, session: SessionDep, deps: WorkspaceDepsDep
) -> Response:
    service.remove_input(session, deps, user, project_id, input_id)
    return Response(status_code=204)
