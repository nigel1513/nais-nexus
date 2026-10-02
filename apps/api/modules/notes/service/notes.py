"""Note lifecycle (openapi getOrCreateTodayNote/getNote/listNotes/updateNoteBlocks/submitNote/rejectNote/reviseNote/
deleteNote). Signing and verification live in service/signing.py.

States: DRAFT (recorder-only, editable) -> SUBMITTED (locked, content_hash fixed, witness snapshot taken) -> SIGNED
(immutable, chained). A witness rejects SUBMITTED back to DRAFT; a SIGNED note changes only by a new version.
"""

from datetime import date, datetime, timedelta, timezone
from typing import Literal
from uuid import UUID

from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.notes import jobs, repo
from api.modules.notes.access import (
    DRAFT,
    SIGNED,
    SUBMITTED,
    Relation,
    load,
    readable,
    recorder_note,
    require_active,
    witness_snapshot,
)
from api.modules.notes.deps import NotesDeps
from api.modules.notes.errors import (
    archived,
    conflict,
    invalid,
    locked,
    not_found,
    not_witness,
    unaccepted_ai,
)
from api.modules.notes.hashing import content_hash
from api.modules.notes.schemas import NoteBlocksIn, RejectIn, ResearchNote, ResearchNoteSummary
from api.modules.notes.views import event_payload, note_view, project_name, summary_views
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.generated.event_types import EventType
from api.platform.ids import new_id
from api.platform.outbox import outbox
from api.platform.pagination import Page, PageInfo, PageParams, encode_cursor

KST = timezone(timedelta(hours=9), "Asia/Seoul")  # Korea observes no daylight saving time


def seoul_date(at: datetime) -> date:
    return at.astimezone(KST).date()


# ---------------------------------------------------------------- today / read


def get_or_create_today(
    session: Session, deps: NotesDeps, user: CurrentUser, project_id: UUID
) -> tuple[ResearchNote, bool]:
    """(note, created). The caller's latest version for today (Asia/Seoul), else a new DRAFT whose organization is
    the recorder's current organization, fixed for the note's life."""
    projects = deps.projects
    if projects.get_member_role(project_id, user.user_id) is None:
        raise not_found("Project")
    if not projects.is_active_member(project_id, user.user_id):
        raise archived()
    now = clock.now()
    today = seoul_date(now)
    note = repo.latest_version(session, project_id, user.user_id, today)
    created = False
    if note is None:
        note = repo.insert_note(
            session,
            note_id=new_id(),
            project_id=project_id,
            organization_id=user.organization_id,
            recorder_id=user.user_id,
            note_date=today,
            version=1,
            previous_version_id=None,
            status=DRAFT,
            revision=1,
            draft_status="NONE",
            created_at=now,
            updated_at=now,
        )
        created = note is not None
        if note is None:  # a concurrent request created it first
            note = repo.latest_version(session, project_id, user.user_id, today)
            if note is None:
                raise conflict("Today's note is being created; retry.")
    return note_view(session, deps, note), created


def get_note(session: Session, deps: NotesDeps, user: CurrentUser, note_id: UUID) -> ResearchNote:
    """A read by anyone but the recorder is logged (notes.note.viewed.v1, 열람 관리대장)."""
    note, relation = readable(session, deps, user, note_id)
    if relation is not Relation.RECORDER:
        emit_viewed(session, user, note)
    return note_view(session, deps, note)


def emit_viewed(session: Session, user: CurrentUser, note: RowMapping) -> None:
    outbox.write(
        session,
        EventType.NOTES_NOTE_VIEWED_V1,
        event_payload(note, user.user_id, clock.now(), status=note["status"]),
        EventActor.for_user(user),
    )


def _list_key(params: PageParams) -> tuple[date, UUID] | None:
    if params.cursor is None:
        return None
    try:
        day, ident = params.cursor
        return date.fromisoformat(str(day)), UUID(str(ident))
    except (TypeError, ValueError) as exc:
        raise invalid("cursor", "INVALID_CURSOR", "Invalid pagination cursor.") from exc


def check_range(date_from: date | None, date_to: date | None) -> None:
    if date_from is not None and date_to is not None and date_from > date_to:
        raise invalid("from", "AFTER_TO", "from must not be after to.")


def list_notes(
    session: Session,
    deps: NotesDeps,
    user: CurrentUser,
    *,
    role: Literal["recorder", "witness"],
    project_id: UUID | None,
    statuses: list[str] | None,
    date_from: date | None,
    date_to: date | None,
    params: PageParams,
) -> Page[ResearchNoteSummary]:
    check_range(date_from, date_to)
    after = _list_key(params)
    if role == "recorder":
        rows = repo.list_recorder_notes(
            session,
            user.user_id,
            project_id=project_id,
            statuses=statuses,
            date_from=date_from,
            date_to=date_to,
            after=after,
            limit=params.limit + 1,
        )
    else:
        member_of = deps.projects.list_project_ids_for_member(user.user_id)
        project_ids = [p for p in member_of if project_id is None or p == project_id]
        visible = [s for s in (statuses or (SUBMITTED, SIGNED)) if s in (SUBMITTED, SIGNED)]
        rows = repo.list_witness_notes(
            session,
            user.user_id,
            project_ids=project_ids,
            statuses=visible,
            date_from=date_from,
            date_to=date_to,
            after=after,
            limit=params.limit + 1,
        )
    has_more = len(rows) > params.limit
    shown = rows[: params.limit]
    next_cursor = (
        encode_cursor([shown[-1]["note_date"].isoformat(), str(shown[-1]["note_id"])])
        if has_more and shown
        else None
    )
    return Page(
        items=summary_views(session, deps, shown), page=PageInfo(next_cursor=next_cursor, has_more=has_more)
    )


# ---------------------------------------------------------------- blocks


def update_blocks(
    session: Session, deps: NotesDeps, user: CurrentUser, note_id: UUID, if_match: int, body: NoteBlocksIn
) -> ResearchNote:
    """Replace the block list in order: listed block_ids keep origin and evidence; new blocks are HUMAN (always
    accepted); unlisted blocks are deleted. Editing an AI sentence's text accepts it unless `accepted` says otherwise."""
    note = recorder_note(session, deps, user, note_id)
    if note["status"] != DRAFT:
        raise locked()
    if note["revision"] != if_match:
        raise ApiError(
            ErrorCode.CONFLICT,
            "The note changed since it was loaded (If-Match).",
            {"revision": note["revision"]},
        )
    existing = {b["block_id"]: b for b in repo.load_blocks(session, [note_id])[note_id]}
    rows = []
    for position, block in enumerate(body.blocks):
        if block.block_id is None:
            rows.append(
                {
                    "block_id": new_id(),
                    "position": position,
                    "section": block.section.value,
                    "text": block.text,
                    "origin": "HUMAN",
                    "accepted": True,
                    "evidence": [],
                }
            )
            continue
        old = existing.get(block.block_id)
        if old is None:
            raise invalid(
                f"blocks.{position}.block_id", "UNKNOWN_BLOCK", "block_id is not a block of this note."
            )
        if old["origin"] == "HUMAN":
            accepted = True
        elif block.accepted is not None:
            accepted = block.accepted
        else:
            accepted = old["accepted"] or block.text != old["text"]
        rows.append(
            {
                "block_id": old["block_id"],
                "position": position,
                "section": block.section.value,
                "text": block.text,
                "origin": old["origin"],
                "accepted": accepted,
                "evidence": old["evidence"],
            }
        )
    repo.replace_blocks(session, note_id, rows)
    note = repo.update_note(session, note_id, revision=note["revision"] + 1, updated_at=clock.now())
    jobs.embed_after_commit(session, deps, note_id)
    return note_view(session, deps, note)


# ---------------------------------------------------------------- submit / reject


def fix_content(
    session: Session,
    note: RowMapping,
    *,
    witness_required: bool,
    witness_user_ids: list[UUID],
) -> RowMapping:
    """DRAFT -> SUBMITTED: refuse unaccepted AI blocks, fix content_hash and store the witness snapshot."""
    blocks = repo.load_blocks(session, [note["note_id"]])[note["note_id"]]
    if any(b["origin"] == "AI" and not b["accepted"] for b in blocks):
        raise unaccepted_ai()
    now = clock.now()
    return repo.update_note(
        session,
        note["note_id"],
        status=SUBMITTED,
        draft_status="NONE",  # a pending LLM draft no longer applies (jobs._finish discards it)
        draft_error=None,
        content_hash=content_hash(note, blocks),
        witness_required=witness_required,
        witness_user_ids=witness_user_ids,
        submitted_at=now,
        rejected_reason=None,
        updated_at=now,
    )


def submit(session: Session, deps: NotesDeps, user: CurrentUser, note_id: UUID) -> ResearchNote:
    note = recorder_note(session, deps, user, note_id)
    if note["status"] != DRAFT:
        raise locked()
    required, witnesses = witness_snapshot(session, deps, note["project_id"], note["recorder_id"])
    if required and not witnesses:
        raise conflict(
            "The project requires a witness, but none of its configured witnesses can witness this note."
        )
    note = fix_content(session, note, witness_required=required, witness_user_ids=witnesses)
    outbox.write(
        session,
        EventType.NOTES_NOTE_SUBMITTED_V1,
        event_payload(
            note,
            user.user_id,
            note["submitted_at"],
            project_name=project_name(deps, note["project_id"]),
            witness_user_ids=[str(w) for w in witnesses],
            content_hash=note["content_hash"],
        ),
        EventActor.for_user(user),
    )
    return note_view(session, deps, note)


def reject(
    session: Session, deps: NotesDeps, user: CurrentUser, note_id: UUID, body: RejectIn
) -> ResearchNote:
    """A snapshot witness returns a SUBMITTED note to its recorder: content_hash, snapshot and signatures are cleared
    (the next submit takes them anew); the signature history stays in the audit log."""
    note, relation = load(session, deps, user, note_id, for_update=True)
    if relation is not Relation.WITNESS:
        raise not_witness()
    if note["status"] != SUBMITTED:
        raise locked()
    require_active(deps, note["project_id"], user)
    now = clock.now()
    note = repo.update_note(
        session,
        note_id,
        status=DRAFT,
        content_hash=None,
        witness_required=None,
        witness_user_ids=None,
        draft_status="NONE",
        draft_error=None,
        rejected_reason=body.reason,
        updated_at=now,
    )
    repo.delete_signatures(session, note_id)
    outbox.write(
        session,
        EventType.NOTES_NOTE_REJECTED_V1,
        event_payload(
            note, user.user_id, now, project_name=project_name(deps, note["project_id"]), reason=body.reason
        ),
        EventActor.for_user(user),
    )
    return note_view(session, deps, note)


# ---------------------------------------------------------------- revise / delete


def revise(session: Session, deps: NotesDeps, user: CurrentUser, note_id: UUID) -> ResearchNote:
    """SIGNED -> a new DRAFT version (version + 1, blocks copied under new ids); the signed version is untouched.
    Only the latest version of the day is revised."""
    note = recorder_note(session, deps, user, note_id)
    if note["status"] != SIGNED:
        raise locked()
    latest = repo.latest_version(session, note["project_id"], note["recorder_id"], note["note_date"])
    if latest is None or latest["version"] != note["version"]:
        raise conflict("A newer version of this note exists; revise the latest version.")
    now = clock.now()
    draft = repo.insert_note(
        session,
        note_id=new_id(),
        project_id=note["project_id"],
        organization_id=note["organization_id"],
        recorder_id=note["recorder_id"],
        note_date=note["note_date"],
        version=note["version"] + 1,
        previous_version_id=note["note_id"],
        status=DRAFT,
        revision=1,
        draft_status="NONE",
        created_at=now,
        updated_at=now,
    )
    if draft is None:
        raise conflict("A newer version of this note exists; revise the latest version.")
    blocks = repo.load_blocks(session, [note_id])[note_id]
    repo.replace_blocks(
        session,
        draft["note_id"],
        [
            {
                "block_id": new_id(),
                "position": b["position"],
                "section": b["section"],
                "text": b["text"],
                "origin": b["origin"],
                "accepted": b["accepted"],
                "evidence": b["evidence"],
            }
            for b in blocks
        ],
    )
    jobs.embed_after_commit(session, deps, draft["note_id"])
    return note_view(session, deps, draft)


def delete(session: Session, deps: NotesDeps, user: CurrentUser, note_id: UUID) -> None:
    note = recorder_note(session, deps, user, note_id)
    if note["status"] != DRAFT:
        raise locked()
    repo.delete_note(session, note_id)
