"""Project outputs: /projects/{project_id}/outputs[/{output_id}[/complete|/download]] (openapi tag `workspace`)."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends

from api.modules.workspace.deps import WorkspaceDepsDep
from api.modules.workspace.schemas import (
    Output,
    OutputDownload,
    OutputKind,
    OutputUploadIn,
    OutputUploadSession,
)
from api.modules.workspace.service import outputs as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep
from api.platform.pagination import Page, PageParams, page_params

router = APIRouter(tags=["workspace"])
PageDep = Annotated[PageParams, Depends(page_params)]


@router.get("/projects/{project_id}/outputs", operation_id="listOutputs")
def list_outputs(
    project_id: UUID,
    user: CurrentUserDep,
    session: SessionDep,
    deps: WorkspaceDepsDep,
    paging: PageDep,
    kind: OutputKind | None = None,
) -> Page[Output]:
    return service.list_outputs(
        session, deps, user, project_id, kind=kind.value if kind else None, params=paging
    )


@router.post("/projects/{project_id}/outputs", operation_id="createOutputUpload", status_code=201)
def create_output_upload(
    project_id: UUID, body: OutputUploadIn, user: CurrentUserDep, session: SessionDep, deps: WorkspaceDepsDep
) -> OutputUploadSession:
    return service.create_upload(session, deps, user, project_id, body)


@router.post("/projects/{project_id}/outputs/{output_id}/complete", operation_id="completeOutputUpload")
def complete_output_upload(
    project_id: UUID, output_id: UUID, user: CurrentUserDep, session: SessionDep, deps: WorkspaceDepsDep
) -> Output:
    return service.complete_upload(session, deps, user, project_id, output_id)


@router.get("/projects/{project_id}/outputs/{output_id}", operation_id="getOutput")
def get_output(
    project_id: UUID, output_id: UUID, user: CurrentUserDep, session: SessionDep, deps: WorkspaceDepsDep
) -> Output:
    return service.get_output(session, deps, user, project_id, output_id)


@router.post(
    "/projects/{project_id}/outputs/{output_id}/download", operation_id="getOutputDownload", status_code=201
)
def get_output_download(
    project_id: UUID, output_id: UUID, user: CurrentUserDep, session: SessionDep, deps: WorkspaceDepsDep
) -> OutputDownload:
    return service.download(session, deps, user, project_id, output_id)
