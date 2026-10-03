from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Query

from api.modules.catalog.deps import CatalogDepsDep
from api.modules.catalog.service import history as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["catalog"])


@router.get("/datasets/{dataset_id}/file-history", operation_id="getFileHistory")
def get_file_history(
    dataset_id: UUID,
    path: Annotated[str, Query(pattern=r"^[A-Za-z0-9._/-]{1,512}$")],
    session: SessionDep,
    user: CurrentUserDep,
) -> dict[str, Any]:
    return service.file_history(session, user, dataset_id, path)


@router.get("/dataset-versions/{version_id}/citation", operation_id="getDatasetCitation")
def get_dataset_citation(
    version_id: UUID,
    session: SessionDep,
    user: CurrentUserDep,
    deps: CatalogDepsDep,
    style: Literal["text", "bibtex", "datacite-json"] = "text",
) -> dict[str, Any]:
    return service.citation(session, deps, user, version_id, style)
