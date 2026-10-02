"""Who may see and act on a research note (openapi M14 descriptions; 국가연구개발 연구노트 관리 지침).

Each caller stands in exactly one relation to a note (classify):
- RECORDER: the note's recorder, always (even after leaving the project: their own record).
- HIDDEN: everyone who may not know the note exists -> 404. Anyone but the recorder for a DRAFT (DRAFT is
  recorder-only), and non-members of the project.
- WITNESS: a user in the note's witness snapshot (taken at submit) who is still an ACTIVE member of the project.
- MEMBER: any other ACTIVE member of the project -> 403 (FORBIDDEN, or NOTE_NOT_WITNESS for witness operations).
"Member" means an ACTIVE membership in a project of any status (ProjectQueryPort.get_member_role); changing anything
also needs the project to be ACTIVE (is_active_member), else 409 PROJECT_ARCHIVED.
"""

from enum import StrEnum
from uuid import UUID

from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.notes import repo
from api.modules.notes.deps import NotesDeps
from api.modules.notes.errors import archived, forbidden, not_found
from api.platform.auth import CurrentUser

DRAFT, SUBMITTED, SIGNED = "DRAFT", "SUBMITTED", "SIGNED"


class Relation(StrEnum):
    RECORDER = "RECORDER"
    WITNESS = "WITNESS"
    MEMBER = "MEMBER"
    HIDDEN = "HIDDEN"


def classify(deps: NotesDeps, user: CurrentUser, note: RowMapping) -> Relation:
    if note["recorder_id"] == user.user_id:
        return Relation.RECORDER
    if note["status"] == DRAFT:
        return Relation.HIDDEN
    if deps.projects.get_member_role(note["project_id"], user.user_id) is None:
        return Relation.HIDDEN
    if note["witness_required"] and user.user_id in (note["witness_user_ids"] or ()):
        return Relation.WITNESS
    return Relation.MEMBER


def load(
    session: Session, deps: NotesDeps, user: CurrentUser, note_id: UUID, *, for_update: bool = False
) -> tuple[RowMapping, Relation]:
    """The note and the caller's relation to it; 404 when it does not exist or is HIDDEN from the caller."""
    note = repo.load_note(session, note_id, for_update=for_update)
    if note is None:
        raise not_found()
    relation = classify(deps, user, note)
    if relation is Relation.HIDDEN:
        raise not_found()
    return note, relation


def readable(
    session: Session, deps: NotesDeps, user: CurrentUser, note_id: UUID
) -> tuple[RowMapping, Relation]:
    """getNote / verifyNote: the recorder and snapshot witnesses; other members 403."""
    note, relation = load(session, deps, user, note_id)
    if relation is Relation.MEMBER:
        raise forbidden("Only the recorder and the note's witnesses can read this note.")
    return note, relation


def recorder_note(session: Session, deps: NotesDeps, user: CurrentUser, note_id: UUID) -> RowMapping:
    """Recorder-only changes: the note locked FOR UPDATE. Others get the getNote answer (404 hidden, else 403); the
    recorder must still be an ACTIVE member of an ACTIVE project."""
    note, relation = load(session, deps, user, note_id, for_update=True)
    if relation is not Relation.RECORDER:
        raise forbidden("Only the recorder can change this note.")
    require_active(deps, note["project_id"], user)
    return note


def require_active(deps: NotesDeps, project_id: UUID, user: CurrentUser) -> None:
    projects = deps.projects
    if projects.get_member_role(project_id, user.user_id) is None:
        raise forbidden("Only ACTIVE members of the project can change its research notes.")
    if not projects.is_active_member(project_id, user.user_id):
        raise archived()


def witness_snapshot(
    session: Session, deps: NotesDeps, project_id: UUID, recorder_id: UUID
) -> tuple[bool, list[UUID]]:
    """(witness_required, witness_user_ids) as a submit would take them now: the project's configured witnesses who
    are ACTIVE members, never the recorder themself; no witnesses at all when none is required."""
    row = repo.load_settings(session, project_id)
    if row is None or not row["witness_required"]:
        return False, []
    projects = deps.projects
    witnesses = [
        w for w in row["witness_user_ids"] if w != recorder_id and projects.is_active_member(project_id, w)
    ]
    return True, witnesses
