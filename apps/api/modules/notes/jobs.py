"""Dramatiq actor `notes.draft_note` (queue `notes`), the evening schedule `notes.daily_drafts` and enqueue-after-commit.

One delivery: claim (note locked FOR UPDATE; DRAFT and draft_status QUEUED -> RUNNING; the day's evidence and the
recorder's MEMO text read in the same transaction) -> no transaction held while the local LLM answers -> finish (note
locked FOR UPDATE again; still DRAFT -> AI blocks appended, revision + 1, draft_status DONE).
- An unusable answer (ValueError: no JSON object, wrong shape) is asked again once, then FAILED.
- An unreachable LLM (LlmUnavailable: timeout, connection, 5xx) or the LLM switched off -> FAILED at once.
- FAILED leaves the blocks as they were and shows the recorder FAILED_MESSAGE.
- A note that left DRAFT meanwhile (submitted or signed) is not written at all: the result is discarded and its draft
  fields stay as they were (the guard trigger refuses any write to a SIGNED note; SUBMITTED is treated the same).
- A note re-requested meanwhile (draft_status back to QUEUED) keeps QUEUED: its own message runs next.

Daily: every 15 minutes, but it selects only inside KST 19:00-19:14, so one run per evening does the work: every
researcher with evidence today who is an ACTIVE member of the project gets their latest note of today drafted (a
DRAFT is created when they have none; SUBMITTED/SIGNED notes are left alone). Nothing runs while the LLM is off.

The actor is defined at import time: the platform sets the broker BEFORE importing modules (D-036).
"""

import logging
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from uuid import UUID

import dramatiq
from dramatiq.middleware import TimeLimitExceeded
from sqlalchemy import event
from sqlalchemy.orm import Session

from api.modules.notes import repo
from api.modules.notes.access import DRAFT
from api.modules.notes.deps import NotesDeps
from api.modules.notes.drafting.apply import new_blocks
from api.modules.notes.drafting.parse import DraftSentence, parse_draft
from api.modules.notes.drafting.prompt import (
    KST,
    PromptItem,
    build_messages,
    evidence_rows,
    prompt_items,
)
from api.modules.notes.wiring import build_default_deps
from api.platform import clock, ports
from api.platform.db import session_factory
from api.platform.errors import ApiError
from api.platform.ids import new_id
from api.platform.llm import ChatMessage, LlmUnavailable
from api.platform.scheduler import Scheduler

logger = logging.getLogger("nais.notes")

QUEUE = "notes"
FAILED_MESSAGE = "초안을 만들지 못했습니다. 잠시 후 다시 시도하세요."
MAX_ATTEMPTS = 2  # an unusable answer is asked again once
TIME_LIMIT_MS = 10 * 60 * 1000  # waits for the shared GPU (one chat at a time per process) + two LLM timeouts
DAILY_INTERVAL_S = 900.0
DAILY_WINDOW = (time(19, 0), time(19, 15))  # KST, end exclusive
DAILY_REQUEUE_AFTER = timedelta(
    minutes=15
)  # a note drafted by the schedule is not queued twice in one window
QUEUED, RUNNING, DONE, FAILED = "QUEUED", "RUNNING", "DONE", "FAILED"
_PENDING = "notes.pending_drafts"
_LISTENING = "notes.listening_drafts"


@dataclass
class Runtime:
    """Tests point the job at their database; production uses Settings (None)."""

    database_url: str | None = None


RUNTIME = Runtime()


def _session() -> Session:
    return session_factory(RUNTIME.database_url)()


def _deps() -> NotesDeps:
    try:
        return ports.get(NotesDeps)
    except ports.PortNotProvided:
        return build_default_deps()


# ---------------------------------------------------------------- one delivery


@dataclass(frozen=True)
class _Work:
    items: list[PromptItem]
    has_memo: bool
    messages: list[ChatMessage]


def _claim(note_id: UUID) -> _Work | None:
    """DRAFT + QUEUED -> RUNNING with the prompt built from the note's day. None: nothing to do (duplicate delivery,
    already finished, no longer DRAFT, unknown note)."""
    with _session() as session, session.begin():
        note = repo.load_note(session, note_id, for_update=True)
        if note is None or note["status"] != DRAFT or note["draft_status"] != QUEUED:
            return None
        rows = evidence_rows(
            repo.day_evidence(session, note["project_id"], note["recorder_id"], note["note_date"])
        )
        memos = [
            b["text"]
            for b in repo.load_blocks(session, [note_id])[note_id]
            if b["section"] == "MEMO" and b["origin"] == "HUMAN" and b["text"].strip()
        ]
        repo.update_note(session, note_id, draft_status=RUNNING, draft_error=None)
    items = prompt_items(rows)
    return _Work(items, bool(memos), build_messages(note["note_date"], items, memos))


def _finish(
    note_id: UUID, status: str, work: _Work | None = None, sentences: list[DraftSentence] | None = None
) -> str:
    """DONE (with the sentences to append) or FAILED; "DISCARDED" when the note is no longer DRAFT."""
    with _session() as session, session.begin():
        note = repo.load_note(session, note_id, for_update=True)
        if note is None or note["status"] != DRAFT:
            return "DISCARDED"
        values: dict[str, object] = {}
        if work is not None and sentences:
            existing = repo.load_blocks(session, [note_id])[note_id]
            rows = new_blocks(existing, sentences, work.items)
            if rows:
                repo.append_blocks(session, note_id, rows)
                values |= {"revision": note["revision"] + 1, "updated_at": clock.now()}
        if note["draft_status"] == RUNNING:
            values |= {"draft_status": status, "draft_error": FAILED_MESSAGE if status == FAILED else None}
        if values:
            repo.update_note(session, note_id, **values)
    return status


def draft_note(note_id: UUID) -> str:
    """One delivery. Returns DONE, FAILED, DISCARDED (note left DRAFT meanwhile) or SKIPPED (nothing to do)."""
    work = _claim(note_id)
    if work is None:
        return "SKIPPED"
    try:
        if not work.items and not work.has_memo:
            return _finish(note_id, DONE)
        llm = _deps().llm()
        if llm is None:
            logger.warning("draft failed: the LLM is switched off", extra={"note_id": str(note_id)})
            return _finish(note_id, FAILED)
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                answer = llm.chat_json(work.messages)
                sentences = parse_draft(answer, item_count=len(work.items), has_memo=work.has_memo)
            except LlmUnavailable as exc:
                logger.warning(
                    "draft failed: LLM unavailable", extra={"note_id": str(note_id), "error": str(exc)}
                )
                return _finish(note_id, FAILED)
            except ValueError as exc:  # the answer may quote the prompt: log the type only
                logger.warning(
                    "unusable LLM answer",
                    extra={"note_id": str(note_id), "attempt": attempt, "error_type": type(exc).__name__},
                )
                continue
            return _finish(note_id, DONE, work, sentences)
        return _finish(note_id, FAILED)
    except Exception as exc:
        logger.error("draft crashed", extra={"note_id": str(note_id), "error_type": type(exc).__name__})
        _finish(note_id, FAILED)
        raise


@dramatiq.actor(actor_name="notes.draft_note", queue_name=QUEUE, max_retries=0, time_limit=TIME_LIMIT_MS)
def draft_note_actor(note_id: str) -> None:
    nid = UUID(note_id)
    try:
        draft_note(nid)
    except TimeLimitExceeded:
        _finish(nid, FAILED)


# ---------------------------------------------------------------- enqueue after commit


def _send_pending(session: Session) -> None:
    for note_id in session.info.pop(_PENDING, []):
        try:
            draft_note_actor.send(str(note_id))
        except Exception:  # the note stays QUEUED; the recorder can ask again after a minute
            logger.exception("could not enqueue draft", extra={"note_id": str(note_id)})


def _drop_pending(session: Session) -> None:
    session.info.pop(_PENDING, None)


def enqueue_after_commit(session: Session, note_id: UUID) -> None:
    """Send the Dramatiq message only once draft_status QUEUED is committed (never for a rolled-back request)."""
    session.info.setdefault(_PENDING, []).append(note_id)
    if not session.info.get(_LISTENING):
        event.listen(session, "after_commit", _send_pending)
        event.listen(session, "after_rollback", _drop_pending)
        session.info[_LISTENING] = True


# ---------------------------------------------------------------- evening schedule


def in_daily_window(now: datetime) -> bool:
    start, end = DAILY_WINDOW
    return start <= now.astimezone(KST).time() < end


def daily_drafts() -> int:
    """Queue today's drafts (inside the evening window only). Returns the number of notes queued."""
    now = clock.now()
    if not in_daily_window(now):
        return 0
    deps = _deps()
    if deps.llm() is None:
        return 0
    try:
        projects = deps.projects
    except ApiError:
        logger.warning("daily drafts skipped: the project module is not wired")
        return 0
    today = now.astimezone(KST).date()
    with _session() as session:
        recorders = repo.day_recorders(session, today)
    queued = 0
    for r in recorders:
        if not projects.is_active_member(r["project_id"], r["actor_id"]):
            continue
        with _session() as session, session.begin():
            if _queue_daily(session, r["project_id"], r["actor_id"], r["organization_id"], today, now):
                queued += 1
    return queued


def _queue_daily(
    session: Session,
    project_id: UUID,
    recorder_id: UUID,
    organization_id: str | None,
    today: date,
    now: datetime,
) -> bool:
    note = repo.latest_version(session, project_id, recorder_id, today)
    if note is None:
        if organization_id is None:  # their organization is known only from their own events
            return False
        repo.insert_note(
            session,
            note_id=new_id(),
            project_id=project_id,
            organization_id=UUID(organization_id),
            recorder_id=recorder_id,
            note_date=today,
            version=1,
            previous_version_id=None,
            status=DRAFT,
            revision=1,
            draft_status="NONE",
            created_at=now,
            updated_at=now,
        )
        note = repo.latest_version(session, project_id, recorder_id, today)
        if note is None:
            return False
    note = repo.load_note(session, note["note_id"], for_update=True)
    if note is None or note["status"] != DRAFT or note["draft_status"] in (QUEUED, RUNNING):
        return False
    requested = note["draft_requested_at"]
    if requested is not None and now - requested < DAILY_REQUEUE_AFTER:
        return False
    repo.update_note(session, note["note_id"], draft_status=QUEUED, draft_error=None, draft_requested_at=now)
    enqueue_after_commit(session, note["note_id"])
    return True


def _daily_job() -> None:
    queued = daily_drafts()
    if queued:
        logger.info("daily drafts queued", extra={"count": queued})


def register_worker(broker: dramatiq.Broker, scheduler: Scheduler) -> None:
    """ModuleSpec.register_worker: the actor was declared on the broker at import; add the evening schedule."""
    if draft_note_actor.broker is not broker:
        raise RuntimeError("configure the Dramatiq broker before importing api.modules.notes (D-036)")
    scheduler.every(DAILY_INTERVAL_S, "notes.daily_drafts", _daily_job)
