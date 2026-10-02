"""/notes..., /projects/{project_id}/notes/today (openapi tag `notes`).

/notes/export is declared before /notes/{note_id} so the literal segment is not parsed as a note id (keep
/notes/search, Task 11, above it too).
"""

from datetime import date
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import StreamingResponse

from api.modules.notes.deps import NotesDepsDep
from api.modules.notes.schemas import (
    NoteBlocksIn,
    NoteStatus,
    NoteVerification,
    RejectIn,
    ResearchNote,
    ResearchNoteSummary,
)
from api.modules.notes.service import drafting, export, signing
from api.modules.notes.service import notes as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep
from api.platform.pagination import Page, PageParams, page_params
from api.platform.settings import Settings, get_settings

router = APIRouter(tags=["notes"])
PageDep = Annotated[PageParams, Depends(page_params)]
IfMatch = Annotated[str, Header(alias="If-Match", pattern=r'^"?[1-9][0-9]{0,8}"?$')]


@router.get("/notes", operation_id="listNotes")
def list_notes(
    user: CurrentUserDep,
    session: SessionDep,
    deps: NotesDepsDep,
    paging: PageDep,
    project_id: UUID | None = None,
    status: Annotated[list[NoteStatus] | None, Query()] = None,
    date_from: Annotated[date | None, Query(alias="from")] = None,
    date_to: Annotated[date | None, Query(alias="to")] = None,
    role: Literal["recorder", "witness"] = "recorder",
) -> Page[ResearchNoteSummary]:
    return service.list_notes(
        session,
        deps,
        user,
        role=role,
        project_id=project_id,
        statuses=[s.value for s in status] if status else None,
        date_from=date_from,
        date_to=date_to,
        params=paging,
    )


@router.get(
    "/notes/export",
    operation_id="exportNotes",
    response_class=StreamingResponse,
    responses={200: {"content": {"application/zip": {"schema": {"type": "string", "format": "binary"}}}}},
)
def export_notes(
    project_id: UUID,
    request: Request,
    user: CurrentUserDep,
    session: SessionDep,
    deps: NotesDepsDep,
    date_from: Annotated[date | None, Query(alias="from")] = None,
    date_to: Annotated[date | None, Query(alias="to")] = None,
) -> StreamingResponse:
    archive = export.prepare(session, deps, user, project_id, date_from, date_to)
    return StreamingResponse(
        export.stream(archive, deps, _database_url(request)),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{archive.filename}"',
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


def _database_url(request: Request) -> str:
    """The database the request's own session uses (api.platform.db.get_session)."""
    settings: Settings = getattr(request.app.state, "settings", None) or get_settings()
    return settings.database_url


@router.post("/projects/{project_id}/notes/today", operation_id="getOrCreateTodayNote", status_code=200)
def get_or_create_today_note(
    project_id: UUID, response: Response, user: CurrentUserDep, session: SessionDep, deps: NotesDepsDep
) -> ResearchNote:
    note, created = service.get_or_create_today(session, deps, user, project_id)
    if created:
        response.status_code = 201
    return note


@router.get("/notes/{note_id}", operation_id="getNote")
def get_note(note_id: UUID, user: CurrentUserDep, session: SessionDep, deps: NotesDepsDep) -> ResearchNote:
    return service.get_note(session, deps, user, note_id)


@router.delete("/notes/{note_id}", operation_id="deleteNote", status_code=204)
def delete_note(note_id: UUID, user: CurrentUserDep, session: SessionDep, deps: NotesDepsDep) -> Response:
    service.delete(session, deps, user, note_id)
    return Response(status_code=204)


@router.put("/notes/{note_id}/blocks", operation_id="updateNoteBlocks")
def update_note_blocks(
    note_id: UUID,
    body: NoteBlocksIn,
    if_match: IfMatch,
    user: CurrentUserDep,
    session: SessionDep,
    deps: NotesDepsDep,
) -> ResearchNote:
    return service.update_blocks(session, deps, user, note_id, int(if_match.strip('"')), body)


@router.post("/notes/{note_id}/draft", operation_id="draftNote", status_code=202)
def draft_note(note_id: UUID, user: CurrentUserDep, session: SessionDep, deps: NotesDepsDep) -> ResearchNote:
    return drafting.request_draft(session, deps, user, note_id)


@router.post("/notes/{note_id}/submit", operation_id="submitNote")
def submit_note(note_id: UUID, user: CurrentUserDep, session: SessionDep, deps: NotesDepsDep) -> ResearchNote:
    return service.submit(session, deps, user, note_id)


@router.post("/notes/{note_id}/reject", operation_id="rejectNote")
def reject_note(
    note_id: UUID, body: RejectIn, user: CurrentUserDep, session: SessionDep, deps: NotesDepsDep
) -> ResearchNote:
    return service.reject(session, deps, user, note_id, body)


@router.post("/notes/{note_id}/sign", operation_id="signNote")
def sign_note(note_id: UUID, user: CurrentUserDep, session: SessionDep, deps: NotesDepsDep) -> ResearchNote:
    return signing.sign(session, deps, user, note_id)


@router.post("/notes/{note_id}/revise", operation_id="reviseNote", status_code=201)
def revise_note(note_id: UUID, user: CurrentUserDep, session: SessionDep, deps: NotesDepsDep) -> ResearchNote:
    return service.revise(session, deps, user, note_id)


@router.get("/notes/{note_id}/verify", operation_id="verifyNote")
def verify_note(
    note_id: UUID, user: CurrentUserDep, session: SessionDep, deps: NotesDepsDep
) -> NoteVerification:
    return signing.verify(session, deps, user, note_id)
