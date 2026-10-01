from typing import Any
from uuid import UUID

from fastapi import APIRouter

from api.modules.catalog.deps import CatalogDepsDep
from api.modules.catalog.schemas import UploadSessionCreateIn
from api.modules.catalog.service import uploads as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["catalog"])


@router.post(
    "/dataset-versions/{version_id}/upload-session", operation_id="createUploadSession", status_code=201
)
def create_upload_session(
    version_id: UUID,
    body: UploadSessionCreateIn,
    session: SessionDep,
    user: CurrentUserDep,
    deps: CatalogDepsDep,
) -> dict[str, Any]:
    return service.create_upload_session(session, deps, user, version_id, body)


@router.get("/upload-sessions/{upload_session_id}", operation_id="getUploadSession")
def get_upload_session(
    upload_session_id: UUID, session: SessionDep, user: CurrentUserDep, deps: CatalogDepsDep
) -> dict[str, Any]:
    return service.get_upload_session(session, deps, user, upload_session_id)
