"""/internal/notes/* (openapi tag `Internal`, D-049): server-to-server for the web server, never for browsers.

No user token: the header X-NAIS-Internal-Token must equal NAIS_INTERNAL_TOKEN (NotesSettings). While that setting
is empty the endpoints do not exist (404 NOT_FOUND); a missing or wrong token is 403 FORBIDDEN. Both are checked before
the query or body is looked at.
"""

import hmac
from datetime import date
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header
from nais_contracts.api_models import InternalDraftSections, InternalNotebookActivity

from api.modules.notes.deps import NotesDepsDep
from api.modules.notes.schemas import InternalDraftSectionsIn
from api.modules.notes.service import internal as service
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode


def require_internal_token(
    deps: NotesDepsDep,
    token: Annotated[str | None, Header(alias="X-NAIS-Internal-Token", include_in_schema=False)] = None,
) -> None:
    expected = deps.settings.nais_internal_token
    if not expected:
        raise ApiError(ErrorCode.NOT_FOUND, "Not found.")
    if token is None or not hmac.compare_digest(token.encode(), expected.encode()):
        raise ApiError(ErrorCode.FORBIDDEN, "Internal token missing or wrong.")


router = APIRouter(tags=["Internal"], dependencies=[Depends(require_internal_token)])


@router.get("/internal/notes/notebook-activity", operation_id="getInternalNotebookActivity")
def get_internal_notebook_activity(
    user_id: UUID, project_id: UUID, day: date, deps: NotesDepsDep
) -> InternalNotebookActivity:
    return service.notebook_activity(deps, user_id, project_id, day)


@router.post("/internal/notes/draft-sections", operation_id="draftInternalNoteSections")
def draft_internal_note_sections(body: InternalDraftSectionsIn, deps: NotesDepsDep) -> InternalDraftSections:
    return service.draft_sections(deps, body.user_id, body.project_id, body.day)
