"""/internal/notes/* (openapi tag `Internal`, D-049): server-to-server for the web server, never for browsers.

No user token: the header X-NAIS-Internal-Token must equal NAIS_INTERNAL_TOKEN (NotesSettings). While that setting
is empty the endpoints do not exist (404 NOT_FOUND); a missing or wrong token is 403 FORBIDDEN. The router dependency
checks it before anything else: FastAPI validates an endpoint's query parameters after its dependencies ran, and the
POST body is not a FastAPI body parameter (FastAPI would read and decode it before any dependency) but read from the
Request and validated only once the token passed, so a malformed request without the token is still 404/403.
"""

import hmac
from datetime import date
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from nais_contracts.api_models import InternalDraftSections, InternalNotebookActivity
from pydantic import ValidationError

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
    user_id: UUID, project_id: UUID, day: date, deps: NotesDepsDep, detail: bool = False
) -> InternalNotebookActivity:
    return service.notebook_activity(deps, user_id, project_id, day, detail=detail)


_BODY = {
    "requestBody": {
        "required": True,
        "content": {"application/json": {"schema": InternalDraftSectionsIn.model_json_schema()}},
    }
}


@router.post("/internal/notes/draft-sections", operation_id="draftInternalNoteSections", openapi_extra=_BODY)
async def draft_internal_note_sections(request: Request, deps: NotesDepsDep) -> InternalDraftSections:
    raw = await request.body()  # only after require_internal_token passed
    try:
        body = InternalDraftSectionsIn.model_validate_json(raw or b"null")
    except ValidationError as exc:
        raise RequestValidationError(
            [{"loc": ("body", *e["loc"]), "msg": e["msg"], "type": e["type"]} for e in exc.errors()]
        ) from exc
    # The local LLM answers slowly: keep the event loop free.
    return await run_in_threadpool(service.draft_sections, deps, body.user_id, body.project_id, body.day)
