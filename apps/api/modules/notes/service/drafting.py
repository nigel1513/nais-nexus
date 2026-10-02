"""draftNote: queue a local-LLM draft of the recorder's DRAFT note (the work is jobs.draft_note).

Recorder only (others get the getNote answer), DRAFT only (409 NOTE_LOCKED), LLM switched off -> 503
LLM_UNAVAILABLE, once per minute per note (429 RATE_LIMITED). A request clears a previous FAILED error.
"""

from datetime import timedelta
from uuid import UUID

from sqlalchemy.orm import Session

from api.modules.notes import jobs, repo
from api.modules.notes.access import DRAFT, recorder_note
from api.modules.notes.deps import NotesDeps
from api.modules.notes.errors import locked
from api.modules.notes.schemas import ResearchNote
from api.modules.notes.views import note_view
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode

MIN_INTERVAL = timedelta(minutes=1)


def request_draft(session: Session, deps: NotesDeps, user: CurrentUser, note_id: UUID) -> ResearchNote:
    note = recorder_note(session, deps, user, note_id)
    if note["status"] != DRAFT:
        raise locked()
    if deps.llm() is None:
        raise ApiError(ErrorCode.LLM_UNAVAILABLE, "Drafting is unavailable: the local LLM is switched off.")
    now = clock.now()
    last = note["draft_requested_at"]
    if last is not None and now - last < MIN_INTERVAL:
        raise ApiError(ErrorCode.RATE_LIMITED, "A draft of this note was requested less than a minute ago.")
    note = repo.update_note(
        session, note_id, draft_status=jobs.QUEUED, draft_error=None, draft_requested_at=now
    )
    jobs.enqueue_after_commit(session, note_id)
    return note_view(session, deps, note)
