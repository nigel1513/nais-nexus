from typing import Any
from uuid import UUID

from fastapi import APIRouter

from api.modules.catalog.deps import CatalogDepsDep
from api.modules.catalog.service import previews as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["catalog"])


@router.get("/dataset-files/{file_id}/profile", operation_id="getFileProfile")
def get_file_profile(file_id: UUID, session: SessionDep, user: CurrentUserDep) -> dict[str, Any]:
    return service.get_profile(session, user, file_id)


@router.get("/dataset-files/{file_id}/preview", operation_id="getFilePreview")
def get_file_preview(
    file_id: UUID, session: SessionDep, user: CurrentUserDep, deps: CatalogDepsDep
) -> dict[str, Any]:
    return service.get_preview(session, deps, user, file_id)
