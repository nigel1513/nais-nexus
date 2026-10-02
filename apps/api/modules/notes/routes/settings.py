"""/projects/{project_id}/note-settings (openapi tag `notes`)."""

from uuid import UUID

from fastapi import APIRouter

from api.modules.notes.deps import NotesDepsDep
from api.modules.notes.schemas import NoteSettings, NoteSettingsIn
from api.modules.notes.service import settings as service
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep

router = APIRouter(tags=["notes"])


@router.get("/projects/{project_id}/note-settings", operation_id="getNoteSettings")
def get_note_settings(
    project_id: UUID, user: CurrentUserDep, session: SessionDep, deps: NotesDepsDep
) -> NoteSettings:
    return service.get_settings(session, deps, user, project_id)


@router.patch("/projects/{project_id}/note-settings", operation_id="updateNoteSettings")
def update_note_settings(
    project_id: UUID, body: NoteSettingsIn, user: CurrentUserDep, session: SessionDep, deps: NotesDepsDep
) -> NoteSettings:
    return service.update_settings(session, deps, user, project_id, body)
