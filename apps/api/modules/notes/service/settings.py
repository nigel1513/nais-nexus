"""Project note settings (openapi getNoteSettings/updateNoteSettings).

Read: ACTIVE members (else 404). Update: PROJECT_OWNER / PROJECT_ADMIN of an ACTIVE project (else 403); witnesses
must be ACTIVE members (422), and witness_required needs at least one witness (422). Changes apply to notes submitted
afterwards only: every submitted note keeps its own snapshot.
"""

from typing import Any
from uuid import UUID

from sqlalchemy.orm import Session

from api.modules.notes import repo
from api.modules.notes.deps import NotesDeps
from api.modules.notes.errors import forbidden, invalid, not_found
from api.modules.notes.schemas import NoteSettings, NoteSettingsIn
from api.platform import clock
from api.platform.auth import CurrentUser

MANAGERS = frozenset({"PROJECT_OWNER", "PROJECT_ADMIN"})


def _view(deps: NotesDeps, project_id: UUID, required: bool, witnesses: list[UUID]) -> NoteSettings:
    return NoteSettings.model_validate(
        {
            "project_id": project_id,
            "witness_required": required,
            "witness_user_ids": witnesses,
            "llm_enabled": deps.settings.nais_llm_enabled,
        }
    )


def get_settings(session: Session, deps: NotesDeps, user: CurrentUser, project_id: UUID) -> NoteSettings:
    if deps.projects.get_member_role(project_id, user.user_id) is None:
        raise not_found("Project")
    row = repo.load_settings(session, project_id)
    if row is None:
        return _view(deps, project_id, False, [])
    return _view(deps, project_id, row["witness_required"], list(row["witness_user_ids"]))


def update_settings(
    session: Session, deps: NotesDeps, user: CurrentUser, project_id: UUID, body: NoteSettingsIn
) -> NoteSettings:
    projects = deps.projects
    role = projects.get_member_role(project_id, user.user_id)
    if role is None:
        raise not_found("Project")
    if role not in MANAGERS:
        raise forbidden("Only the project owner or an admin can change note settings.")
    if not projects.is_active_member(project_id, user.user_id):
        raise forbidden("The project is archived; its note settings are read-only.")
    current = repo.load_settings(session, project_id)
    values: dict[str, Any] = {
        "witness_required": current["witness_required"] if current else False,
        "witness_user_ids": list(current["witness_user_ids"]) if current else [],
    }
    values |= {name: getattr(body, name) for name in body.model_fields_set}
    if "witness_user_ids" in body.model_fields_set:
        for index, witness in enumerate(values["witness_user_ids"]):
            if not projects.is_active_member(project_id, witness):
                raise invalid(
                    f"witness_user_ids.{index}",
                    "NOT_ACTIVE_MEMBER",
                    "Witnesses must be ACTIVE project members.",
                )
    if values["witness_required"] and not values["witness_user_ids"]:
        raise invalid(
            "witness_user_ids", "WITNESS_REQUIRED", "Name at least one witness when witnesses are required."
        )
    row = repo.upsert_settings(session, project_id, **values, updated_by=user.user_id, updated_at=clock.now())
    return _view(deps, project_id, row["witness_required"], list(row["witness_user_ids"]))
