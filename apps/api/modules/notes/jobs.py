"""Dramatiq actor `notes.draft_note` (queue `notes`), the evening schedule `notes.daily_drafts` and enqueue-after-commit.

A draft request (draftNote or the schedule) sets draft_status QUEUED and draft_requested_at = now; that timestamp
identifies the request. One delivery:
claim (note locked FOR UPDATE; DRAFT and QUEUED -> RUNNING) -> the recorder's notebooks of the note's project and day
read from the NotebookActivityPort (drafting/prompt.py; workspace evidence is not sent) -> no transaction held while the
local LLM answers -> finish (note locked FOR UPDATE again; the
answer is applied only while the note is still DRAFT, still RUNNING and still on the same request: AI blocks
appended, revision + 1, draft_status DONE).
- An unusable answer (ValueError: no JSON object, wrong shape) is asked again once, then FAILED.
- An answer cut at MAX_TOKENS (LlmTruncated), an unreachable LLM (LlmUnavailable: timeout, connection, 5xx), the LLM
  switched off, or the actor time limit -> FAILED at once.
- FAILED leaves the blocks as they were and shows the recorder FAILED_MESSAGE.
- Leaving DRAFT (submit, sign, and a witness's reject back to DRAFT) resets draft_status to NONE (service/notes.py), so
  a late answer for such a note, or for a request superseded by a newer one, is discarded without any write.
- QUEUED/RUNNING older than STALE_AFTER (the actor time limit + a minute) is stuck (lost message, killed worker): a
  new request (draftNote or the schedule) reclaims it.

Daily: the scheduler ticks every 15 minutes (and at worker start). The first tick at or after 19:00 KST on a day
claims that day in notes.daily_runs and queues drafts; later ticks that day do nothing, so a worker that was down at
19:00 catches up that evening. Every researcher with notebooks saved today (NotebookActivityPort.list_notebook_authors;
nobody until M07 provides it) who is an ACTIVE member of the project gets their latest note of today drafted (a DRAFT is created when they have none; SUBMITTED/SIGNED notes are left alone). One
researcher failing does not stop the others. Nothing runs (and the day is not claimed) while the LLM is off.

Embeddings (searchNotes, search.py): `notes.embed_notes` (same queue) embeds note versions whose searchable text changed
(sha256 text_hash) in batches of EMBED_BATCH, with no transaction held while the shared GPU answers; an unchanged
text is not embedded again (a SIGNED note, immutable, is embedded once). A save (updateNoteBlocks) or a revise queues
its note EMBED_DELAY after commit, so an editing burst becomes one embedding; the sweep `notes.embed_sweep` (every
EMBED_SWEEP_S) queues notes never embedded or changed since their vector was last checked (lost messages, notes
saved while the service was off). Nothing is queued while the embedding service is off.

The actor is defined at import time: the platform sets the broker BEFORE importing modules (D-036).
"""

import logging
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from uuid import UUID

import dramatiq
from dramatiq.middleware import TimeLimitExceeded
from sqlalchemy import event
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.notes import repo, search
from api.modules.notes.access import DRAFT
from api.modules.notes.deps import NotesDeps
from api.modules.notes.drafting.apply import new_blocks
from api.modules.notes.drafting.parse import DraftSentence, parse_draft
from api.modules.notes.drafting.prompt import KST, PromptItem, build_messages, notebooks, plan
from api.modules.notes.wiring import build_default_deps
from api.platform import clock, ports
from api.platform.db import session_factory
from api.platform.errors import ApiError
from api.platform.ids import new_id
from api.platform.llm import ChatMessage, EmbeddingClient, LlmTruncated, LlmUnavailable
from api.platform.scheduler import Scheduler

logger = logging.getLogger("nais.notes")

QUEUE = "notes"
FAILED_MESSAGE = "초안을 만들지 못했습니다. 잠시 후 다시 시도하세요."
MAX_ATTEMPTS = 2  # an unusable answer is asked again once
# 7 sections x 6 sentences x 120 Korean characters inside JSON (~1 token per Hangul syllable plus keys/indexes); in
# practice far fewer sections are filled.
MAX_TOKENS = 3584
TIME_LIMIT_MS = 10 * 60 * 1000  # waits for the shared GPU (one chat at a time per process) + two LLM timeouts
STALE_AFTER = timedelta(milliseconds=TIME_LIMIT_MS) + timedelta(minutes=1)
DAILY_INTERVAL_S = 900.0
DAILY_FROM = time(19, 0)  # KST
QUEUED, RUNNING, DONE, FAILED = "QUEUED", "RUNNING", "DONE", "FAILED"
_PENDING = "notes.pending_drafts"
_LISTENING = "notes.listening_drafts"
EMBED_BATCH = 16  # texts per embedding call
EMBED_DELAY_MS = 30_000
EMBED_TIME_LIMIT_MS = 5 * 60 * 1000
EMBED_SWEEP_S = 300.0
EMBED_SWEEP_LIMIT = 200  # notes queued per sweep tick
_PENDING_EMBED = "notes.pending_embeddings"


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


def in_progress(note: RowMapping, now: datetime) -> bool:
    """QUEUED or RUNNING for a request younger than STALE_AFTER (older ones are stuck and may be reclaimed)."""
    requested = note["draft_requested_at"]
    return (
        note["draft_status"] in (QUEUED, RUNNING) and requested is not None and now - requested < STALE_AFTER
    )


# ---------------------------------------------------------------- one delivery


@dataclass(frozen=True)
class _Work:
    note_id: UUID
    request: datetime | None  # draft_requested_at of the claimed request
    items: list[PromptItem]
    messages: list[ChatMessage]


def _claim(note_id: UUID) -> _Work | None:
    """DRAFT + QUEUED -> RUNNING, then the prompt built from the recorder's notebooks of the note's project and day.
    None: nothing to do (duplicate delivery, already finished, no longer DRAFT, unknown note)."""
    with _session() as session, session.begin():
        note = repo.load_note(session, note_id, for_update=True)
        if note is None or note["status"] != DRAFT or note["draft_status"] != QUEUED:
            return None
        repo.update_note(session, note_id, draft_status=RUNNING, draft_error=None)
    source = _deps().notebooks.list_notebook_activity(
        note["recorder_id"], note["project_id"], note["note_date"]
    )
    prompt = plan(notebooks(source))
    return _Work(note_id, note["draft_requested_at"], prompt.items, build_messages(note["note_date"], prompt))


def _finish(work: _Work, status: str, sentences: list[DraftSentence] | None = None) -> str:
    """DONE (with the sentences to append) or FAILED; "DISCARDED" when the claimed request no longer stands (the
    note left DRAFT, was reset or re-requested): then nothing is written."""
    with _session() as session, session.begin():
        note = repo.load_note(session, work.note_id, for_update=True)
        if (
            note is None
            or note["status"] != DRAFT
            or note["draft_status"] != RUNNING
            or note["draft_requested_at"] != work.request
        ):
            return "DISCARDED"
        values: dict[str, object] = {
            "draft_status": status,
            "draft_error": FAILED_MESSAGE if status == FAILED else None,
        }
        if sentences:
            existing = repo.load_blocks(session, [work.note_id])[work.note_id]
            rows = new_blocks(existing, sentences, work.items)
            if rows:
                repo.append_blocks(session, work.note_id, rows)
                values |= {"revision": note["revision"] + 1, "updated_at": clock.now()}
        repo.update_note(session, work.note_id, **values)
    return status


def _ask(work: _Work) -> str:
    if not work.items:  # no notebook that day: nothing to draft from
        return _finish(work, DONE)
    llm = _deps().llm()
    log = {"note_id": str(work.note_id)}
    if llm is None:
        logger.warning("draft failed: the LLM is switched off", extra=log)
        return _finish(work, FAILED)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            answer = llm.chat_json(work.messages, max_tokens=MAX_TOKENS)
            sentences = parse_draft(answer, work.items)
        except LlmUnavailable as exc:
            logger.warning("draft failed: LLM unavailable", extra=log | {"error": str(exc)})
            return _finish(work, FAILED)
        except LlmTruncated:
            logger.warning("draft failed: answer cut at max_tokens", extra=log | {"max_tokens": MAX_TOKENS})
            return _finish(work, FAILED)
        except ValueError as exc:  # the answer may quote the prompt: log the type only
            logger.warning(
                "unusable LLM answer", extra=log | {"attempt": attempt, "error_type": type(exc).__name__}
            )
            continue
        return _finish(work, DONE, sentences)
    return _finish(work, FAILED)


def draft_note(note_id: UUID) -> str:
    """One delivery. Returns DONE, FAILED, DISCARDED (the request no longer stands) or SKIPPED (nothing to do)."""
    try:
        work = _claim(note_id)
    except Exception as exc:  # the notebook port failed after the claim: FAILED, not stuck RUNNING
        logger.error("draft claim crashed", extra={"note_id": str(note_id), "error_type": type(exc).__name__})
        _fail_running(note_id)
        raise
    if work is None:
        return "SKIPPED"
    try:
        return _ask(work)
    except TimeLimitExceeded:
        logger.warning("draft failed: time limit", extra={"note_id": str(note_id)})
        return _finish(work, FAILED)
    except Exception as exc:
        logger.error("draft crashed", extra={"note_id": str(note_id), "error_type": type(exc).__name__})
        _finish(work, FAILED)
        raise


def _fail_running(note_id: UUID) -> None:
    with _session() as session, session.begin():
        note = repo.load_note(session, note_id, for_update=True)
        if note is not None and note["status"] == DRAFT and note["draft_status"] == RUNNING:
            repo.update_note(session, note_id, draft_status=FAILED, draft_error=FAILED_MESSAGE)


@dramatiq.actor(actor_name="notes.draft_note", queue_name=QUEUE, max_retries=0, time_limit=TIME_LIMIT_MS)
def draft_note_actor(note_id: str) -> None:
    draft_note(UUID(note_id))


# ---------------------------------------------------------------- enqueue after commit


def _send_pending(session: Session) -> None:
    for note_id in session.info.pop(_PENDING, []):
        try:
            draft_note_actor.send(str(note_id))
        except Exception:  # the note stays QUEUED; it is reclaimed after STALE_AFTER
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


# ---------------------------------------------------------------- embeddings (searchNotes)


def _embed_batch(embedder: EmbeddingClient, texts: list[str]) -> list[list[float]]:
    """Vectors for the texts. A refused batch (ValueError: bad request, odd answer) is retried one text at a time and
    a text refused alone gets an empty vector (not searched semantically until its text changes). LlmUnavailable
    propagates: nothing more is sent now."""
    clipped = [t[: search.EMBED_CHARS] for t in texts]
    try:
        return [search.unit(v) for v in embedder.embed(clipped)]
    except ValueError:
        if len(clipped) == 1:
            logger.warning("embedding refused for a note; stored empty")
            return [[]]
    return [_embed_batch(embedder, [t])[0] for t in clipped]


def embed_notes(note_ids: list[UUID]) -> int:
    """(Re)compute the vectors of the notes whose searchable text (or the embedding model) changed. Returns how many
    were stored. Each row is stamped with the note's updated_at as read, so a change made while the GPU answered
    leaves the row older than the note and the sweep queues it again."""
    deps = _deps()
    embedder = deps.embedder()
    if embedder is None or not note_ids:
        return 0
    model = deps.embed_model()
    with _session() as session, session.begin():
        found = repo.load_notes(session, note_ids)
        texts = {
            n: search.searchable_text(t) for n, t in repo.searchable_blocks(session, list(found)).items()
        }
        stored = repo.embedding_hashes(session, list(found))
        hashes = {n: search.text_hash(model, texts[n]) for n in found}
        for n in found:
            if stored.get(n) == hashes[n]:
                repo.touch_embedding(session, n, found[n]["updated_at"])
    todo = [n for n in found if stored.get(n) != hashes[n]]
    vectors: dict[UUID, list[float]] = {n: [] for n in todo if not texts[n]}  # nothing to search by
    pending = [n for n in todo if texts[n]]
    for start in range(0, len(pending), EMBED_BATCH):
        batch = pending[start : start + EMBED_BATCH]
        try:
            answer = _embed_batch(embedder, [texts[n] for n in batch])
        except LlmUnavailable as exc:  # left for a later message or the sweep
            logger.warning("embedding failed", extra={"notes": len(batch), "error_type": type(exc).__name__})
            break
        vectors.update(zip(batch, answer, strict=True))
    if not vectors:
        return 0
    stored_count = 0
    with _session() as session, session.begin():
        # Notes deleted (DRAFTs) while the GPU answered are skipped; the rest are locked against deletion until commit.
        alive = repo.lock_existing_notes(session, list(vectors))
        for note_id, vector in vectors.items():
            if note_id not in alive:
                continue
            note = found[note_id]
            repo.upsert_embedding(
                session,
                note_id,
                version=note["version"],
                vector=vector,
                text_hash=hashes[note_id],
                at=note["updated_at"],
            )
            stored_count += 1
    return stored_count


@dramatiq.actor(
    actor_name="notes.embed_notes", queue_name=QUEUE, max_retries=0, time_limit=EMBED_TIME_LIMIT_MS
)
def embed_notes_actor(note_ids: list[str]) -> None:
    embed_notes([UUID(n) for n in note_ids])


def _send_embeddings(session: Session) -> None:
    note_ids = session.info.pop(_PENDING_EMBED, None)
    if not note_ids:
        return
    try:
        embed_notes_actor.send_with_options(args=([str(n) for n in note_ids],), delay=EMBED_DELAY_MS)
    except Exception:  # the sweep picks the notes up
        logger.exception("could not enqueue embeddings", extra={"notes": len(note_ids)})


def _drop_embeddings(session: Session) -> None:
    session.info.pop(_PENDING_EMBED, None)


def embed_after_commit(session: Session, deps: NotesDeps, note_id: UUID) -> None:
    """Queue the note's embedding once its change is committed (nothing while the embedding service is off)."""
    if deps.embedder() is None:
        return
    pending = session.info.get(_PENDING_EMBED)
    if pending is None:
        session.info[_PENDING_EMBED] = pending = []
        event.listen(session, "after_commit", _send_embeddings, once=True)
        event.listen(session, "after_rollback", _drop_embeddings, once=True)
    if note_id not in pending:
        pending.append(note_id)


def embed_sweep() -> int:
    """Queue up to EMBED_SWEEP_LIMIT notes without a current embedding. Returns how many were queued."""
    if _deps().embedder() is None:
        return 0
    with _session() as session, session.begin():
        note_ids = repo.unembedded_note_ids(session, limit=EMBED_SWEEP_LIMIT)
    for start in range(0, len(note_ids), EMBED_BATCH):
        embed_notes_actor.send([str(n) for n in note_ids[start : start + EMBED_BATCH]])
    return len(note_ids)


def _embed_sweep_job() -> None:
    queued = embed_sweep()
    if queued:
        logger.info("embeddings queued", extra={"count": queued})


# ---------------------------------------------------------------- evening schedule


def daily_drafts() -> int:
    """Queue today's drafts once per KST day, at the first tick from 19:00. Returns the number of notes queued."""
    now = clock.now()
    local = now.astimezone(KST)
    if local.time() < DAILY_FROM:
        return 0
    deps = _deps()
    if deps.llm() is None:
        return 0
    try:
        projects = deps.projects
    except ApiError:
        logger.warning("daily drafts skipped: the project module is not wired")
        return 0
    today = local.date()
    with _session() as session, session.begin():
        if not repo.claim_daily_run(session, today, now):
            return 0
    authors = list(dict.fromkeys(deps.notebooks.list_notebook_authors(today)))
    try:
        organizations = deps.people.get_organization_ids(list(dict.fromkeys(u for u, _ in authors)))
    except ApiError:  # identity unwired: existing notes are still drafted, none can be created
        logger.warning("daily drafts: organizations unknown, no new notes")
        organizations = {}
    queued = 0
    for user_id, project_id in authors:
        try:
            if not projects.is_active_member(project_id, user_id):
                continue
            with _session() as session, session.begin():
                if _queue_daily(session, project_id, user_id, organizations.get(user_id), today, now):
                    queued += 1
        except Exception as exc:  # one researcher must not stop the evening's other drafts
            logger.error(
                "daily draft failed for a researcher",
                extra={
                    "project_id": str(project_id),
                    "recorder_id": str(user_id),
                    "error_type": type(exc).__name__,
                },
            )
    return queued


def _queue_daily(
    session: Session,
    project_id: UUID,
    recorder_id: UUID,
    organization_id: UUID | None,
    today: date,
    now: datetime,
) -> bool:
    note = repo.latest_version(session, project_id, recorder_id, today)
    if note is None:
        if organization_id is None:  # no public profile (unknown or removed user)
            return False
        repo.insert_note(  # ON CONFLICT DO NOTHING: a note created concurrently is simply re-read
            session,
            note_id=new_id(),
            project_id=project_id,
            organization_id=organization_id,
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
    if note is None or note["status"] != DRAFT or in_progress(note, now):
        return False
    repo.update_note(session, note["note_id"], draft_status=QUEUED, draft_error=None, draft_requested_at=now)
    enqueue_after_commit(session, note["note_id"])
    return True


def _daily_job() -> None:
    queued = daily_drafts()
    if queued:
        logger.info("daily drafts queued", extra={"count": queued})


def register_worker(broker: dramatiq.Broker, scheduler: Scheduler) -> None:
    """ModuleSpec.register_worker: the actor was declared on the broker at import; add the evening schedule (also
    run at worker start, so an evening restart catches up at once)."""
    if draft_note_actor.broker is not broker:
        raise RuntimeError("configure the Dramatiq broker before importing api.modules.notes (D-036)")
    scheduler.every(DAILY_INTERVAL_S, "notes.daily_drafts", _daily_job, run_immediately=True)
    scheduler.every(EMBED_SWEEP_S, "notes.embed_sweep", _embed_sweep_job)
