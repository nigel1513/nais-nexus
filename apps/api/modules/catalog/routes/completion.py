from typing import Any
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Response

from api.modules.catalog.deps import CatalogDepsDep
from api.modules.catalog.schemas import UploadCompleteIn
from api.modules.catalog.service import completion as service
from api.modules.catalog.service.uploads import run_cleanups
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["catalog"])


@router.post("/upload-sessions/{upload_session_id}/complete", operation_id="completeUploadSession")
def complete_upload_session(
    upload_session_id: UUID,
    body: UploadCompleteIn,
    background: BackgroundTasks,
    session: SessionDep,
    user: CurrentUserDep,
    deps: CatalogDepsDep,
) -> dict[str, Any]:
    result, to_verify = service.complete_upload_session(session, deps, user, upload_session_id, body)
    if to_verify:
        # Background tasks run after the response, i.e. after SessionDep committed: the worker sees UPLOADED rows.
        background.add_task(deps.verification.enqueue, to_verify)
    return result


@router.delete(
    "/dataset-versions/{version_id}/files/{file_id}", operation_id="deleteDraftFile", status_code=204
)
def delete_draft_file(
    version_id: UUID,
    file_id: UUID,
    background: BackgroundTasks,
    session: SessionDep,
    user: CurrentUserDep,
    deps: CatalogDepsDep,
) -> Response:
    target = service.delete_draft_file(session, deps, user, version_id, file_id)
    background.add_task(run_cleanups, deps, [target])  # after SessionDep committed
    return Response(status_code=204)
