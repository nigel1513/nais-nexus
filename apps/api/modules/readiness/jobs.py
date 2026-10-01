"""Dramatiq actor `readiness.run_validation`, the stale-job sweeper and enqueue-after-commit (M05 §5, §10).

The actor is defined at import time: the platform sets the broker BEFORE importing modules (D-036).
"""

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

import dramatiq
from dramatiq.middleware import TimeLimitExceeded
from sqlalchemy import ColumnElement, RowMapping, delete, event, or_, select, update
from sqlalchemy.exc import IntegrityError, InterfaceError, OperationalError
from sqlalchemy.orm import Session

from api.modules.readiness.catalog_port import (
    CatalogQueryPort,
    CatalogReadPort,
    ObjectMissing,
    StorageUnavailable,
)
from api.modules.readiness.engine.evaluate import ValidationResult, evaluate
from api.modules.readiness.engine.parsing import FileTimeout, FileTooLarge
from api.modules.readiness.profile_registry import PROFILES
from api.modules.readiness.settings import get_readiness_settings
from api.modules.readiness.tables import check_results, validations
from api.platform import clock, ports
from api.platform.db import session_factory
from api.platform.events import EventActor
from api.platform.generated.event_types import EventType
from api.platform.outbox import outbox
from api.platform.scheduler import Scheduler

logger = logging.getLogger("nais.readiness")
MAX_ATTEMPTS = 3  # first run + 2 retries (M05 §5 / §10 max_retries=2)
QUEUE = "readiness"
STALE_QUEUED_AFTER = timedelta(hours=1)
SWEEP_INTERVAL_S = 600.0
_PENDING = "readiness.pending_jobs"
_LISTENING = "readiness.listening"
_SETTINGS = get_readiness_settings()
_CONCURRENCY = threading.BoundedSemaphore(_SETTINGS.worker_concurrency)
EMPTY_SUMMARY = {"pass": 0, "warning": 0, "fail": 0, "not_applicable": 0}


@dataclass
class Runtime:
    """Tests point the job (and ReadinessQueryPort) at their database; production uses Settings (None)."""

    database_url: str | None = None


RUNTIME = Runtime()


class RetryableInfraError(Exception):
    """Raised after putting the run back to QUEUED so Dramatiq retries the message."""


class _ReuseConflict(Exception):
    """A concurrent identical run COMPLETED first (uq_validation_reuse): ours must not be stored as a second one."""


class _Superseded(Exception):
    """The row left RUNNING while we evaluated (e.g. swept as stale): discard our result."""


DB_ERRORS = (OperationalError, InterfaceError)
DB_RETRIES = 3
DB_RETRY_DELAY_S = 0.5


def _db_retry[T](fn: Callable[[], T]) -> T:
    """Recovery writes (requeue / fail) retry briefly in-process; a DB that stays down becomes a retryable infra
    error for Dramatiq (never a non-retryable crash that strands the row until the sweeper)."""
    for attempt in range(DB_RETRIES):
        try:
            return fn()
        except DB_ERRORS as exc:
            if attempt == DB_RETRIES - 1:
                raise RetryableInfraError(type(exc).__name__) from exc
            time.sleep(DB_RETRY_DELAY_S * (attempt + 1))
    raise AssertionError("unreachable")  # pragma: no cover


def _fail(validation_id: UUID, error: str) -> str:
    """Fail the run; "FAILED" only if this call did it, else "SKIPPED" (someone else already ended the run)."""
    return "FAILED" if _db_retry(lambda: fail_run(validation_id, error)) else "SKIPPED"


def _session() -> Session:
    return session_factory(RUNTIME.database_url)()


# ---------------------------------------------------------------- events


def _actor_for(row: RowMapping) -> EventActor:
    if row["requested_by"] is None:
        return EventActor.system()
    return EventActor(
        type="USER", user_id=row["requested_by"], organization_id=row["requester_organization_id"]
    )


def _write_started(session: Session, row: RowMapping) -> None:
    payload = {
        "validation_id": str(row["validation_id"]),
        "dataset_id": str(row["dataset_id"]),
        "dataset_version_id": str(row["dataset_version_id"]),
        "profile_id": row["profile_id"],
        "profile_version": row["profile_version"],
    }
    outbox.write(
        session,
        EventType.READINESS_VALIDATION_STARTED_V1,
        payload,
        EventActor.system(),
        correlation_id=row["correlation_id"],
    )


def _write_completed(session: Session, row: RowMapping) -> None:
    payload: dict[str, Any] = {
        "validation_id": str(row["validation_id"]),
        "dataset_id": str(row["dataset_id"]),
        "dataset_version_id": str(row["dataset_version_id"]),
        "owner_organization_id": str(row["owner_organization_id"]),
        "profile_id": row["profile_id"],
        "profile_version": row["profile_version"],
        "run_status": row["run_status"],
        "overall_status": row["overall_status"],
        "summary": row["summary"] or EMPTY_SUMMARY,
        "validator_version": row["validator_version"],
        "input_fingerprint": row["input_fingerprint"],
    }
    outbox.write(
        session,
        EventType.READINESS_VALIDATION_COMPLETED_V1,
        payload,
        _actor_for(row),
        correlation_id=row["correlation_id"],
    )


# ---------------------------------------------------------------- state transitions


def start_run(validation_id: UUID) -> RowMapping | None:
    """QUEUED -> RUNNING (attempt+1) + started event. None when not QUEUED (duplicate delivery, already done)."""
    with _session() as session, session.begin():
        row = (
            session.execute(
                update(validations)
                .where(validations.c.validation_id == validation_id, validations.c.run_status == "QUEUED")
                .values(run_status="RUNNING", attempt=validations.c.attempt + 1, started_at=clock.now())
                .returning(validations)
            )
            .mappings()
            .first()
        )
        if row is not None:
            _write_started(session, row)
        return row


def _requeue(validation_id: UUID) -> None:
    """RUNNING -> QUEUED for an infrastructure retry (no event)."""
    with _session() as session, session.begin():
        row = session.execute(
            update(validations)
            .where(validations.c.validation_id == validation_id, validations.c.run_status == "RUNNING")
            .values(run_status="QUEUED")
            .returning(validations.c.validation_id)
        ).first()
        if row is not None:  # partial results are deletable only while not terminal
            session.execute(delete(check_results).where(check_results.c.validation_id == validation_id))


def fail_run(
    validation_id: UUID,
    error: str,
    *,
    from_statuses: tuple[str, ...] = ("RUNNING",),
    guard: ColumnElement[bool] | None = None,
) -> bool:
    """-> FAILED with an error code + short description (never data values) and a completed event.

    One guarded UPDATE (status in `from_statuses` AND `guard`): a COMPLETED/FAILED row is never touched and a
    run a live worker has just claimed is not failed by the sweeper. False when the guard did not match."""
    conditions = [validations.c.validation_id == validation_id, validations.c.run_status.in_(from_statuses)]
    if guard is not None:
        conditions.append(guard)
    with _session() as session, session.begin():
        row = (
            session.execute(
                update(validations)
                .where(*conditions)
                .values(run_status="FAILED", error=error[:500], completed_at=clock.now())
                .returning(validations)
            )
            .mappings()
            .first()
        )
        if row is None:
            return False
        _write_completed(session, row)
        return True


def _complete(validation_id: UUID, result: ValidationResult) -> bool:
    """RUNNING -> COMPLETED in one short tx: lock the RUNNING row, replace any partial results of an interrupted
    attempt, insert the check rows (the trigger forbids them once terminal), flip the status last."""
    try:
        with _session() as session, session.begin():
            locked = session.execute(
                select(validations.c.validation_id)
                .where(validations.c.validation_id == validation_id, validations.c.run_status == "RUNNING")
                .with_for_update()
            ).first()
            if locked is None:  # already COMPLETED/FAILED/QUEUED: write nothing
                raise _Superseded()
            session.execute(delete(check_results).where(check_results.c.validation_id == validation_id))
            session.execute(
                check_results.insert(),
                [
                    {
                        "validation_id": validation_id,
                        "check_id": c.check_id,
                        "ordinal": c.ordinal,
                        "severity": c.severity,
                        "status": c.status,
                        "message": c.message,
                        "evidence": c.evidence,
                    }
                    for c in result.checks
                ],
            )
            row = (
                session.execute(
                    update(validations)
                    .where(validations.c.validation_id == validation_id)
                    .values(
                        run_status="COMPLETED",
                        overall_status=result.overall_status,
                        summary=result.summary,
                        result_sha256=result.result_sha256,
                        completed_at=clock.now(),
                    )
                    .returning(validations)
                )
                .mappings()
                .one()
            )
            _write_completed(session, row)
    except _Superseded:
        logger.warning(
            "validation left RUNNING during evaluation", extra={"validation_id": str(validation_id)}
        )
        return False
    except IntegrityError as exc:
        if "uq_validation_reuse" not in str(exc.orig):
            raise
        logger.warning("identical validation already COMPLETED", extra={"validation_id": str(validation_id)})
        raise _ReuseConflict() from exc
    return True


def run_validation(validation_id: UUID) -> str:
    """One delivery of the job. Returns the resulting run_status, or "SKIPPED" when there was nothing to do
    (duplicate delivery, run already ended by someone else)."""
    try:
        row = start_run(validation_id)
    except DB_ERRORS as exc:  # nothing was claimed: the row is still QUEUED, let Dramatiq redeliver
        raise RetryableInfraError(type(exc).__name__) from exc
    if row is None:
        return "SKIPPED"
    try:
        version = ports.get(CatalogQueryPort).get_version(row["dataset_version_id"])
        if version is None or version.status != "PUBLISHED" or version.metadata_snapshot is None:
            return _fail(validation_id, "VERSION_NOT_FOUND: dataset version is missing or not published")
        result = evaluate(
            version,
            PROFILES[row["profile_id"]],
            ports.get(CatalogReadPort),
            file_timeout_s=_SETTINGS.file_timeout_seconds,
        )
        completed = _complete(validation_id, result)
    except (StorageUnavailable, OperationalError, ports.PortNotProvided) as exc:
        if row["attempt"] < MAX_ATTEMPTS:
            _db_retry(lambda: _requeue(validation_id))
            raise RetryableInfraError(type(exc).__name__) from exc
        return _fail(
            validation_id, f"STORAGE_UNAVAILABLE: {type(exc).__name__} after {MAX_ATTEMPTS} attempts"
        )
    except ObjectMissing as exc:
        path = exc.args[0] if exc.args else "object"
        return _fail(validation_id, f"FILE_NOT_FOUND: {path} is missing in storage")
    except FileTooLarge:
        return _fail(validation_id, "FILE_TOO_LARGE: a file exceeds the validation size limit")
    except FileTimeout:
        return _fail(validation_id, f"FILE_TIMEOUT: parsing exceeded {_SETTINGS.file_timeout_seconds}s")
    except _ReuseConflict:
        return _fail(
            validation_id, "INTERNAL_ERROR: an identical validation already COMPLETED (reuse conflict)"
        )
    except Exception as exc:
        logger.exception("readiness evaluation crashed", extra={"validation_id": str(validation_id)})
        return _fail(validation_id, f"INTERNAL_ERROR: {type(exc).__name__}")
    return "COMPLETED" if completed else "SKIPPED"


def _retry_when(retries: int, exc: BaseException) -> bool:
    """Dramatiq retries only infrastructure errors; the DB attempt counter decides when to give up."""
    return isinstance(exc, RetryableInfraError) and retries < MAX_ATTEMPTS - 1


@dramatiq.actor(
    actor_name="readiness.run_validation",
    queue_name=QUEUE,
    max_retries=MAX_ATTEMPTS - 1,
    retry_when=_retry_when,
    min_backoff=1_000,
    max_backoff=30_000,
    time_limit=_SETTINGS.run_timeout_seconds * 1000,
)
def run_validation_actor(validation_id: str) -> None:
    vid = UUID(validation_id)
    # time_limit also counts the wait for this semaphore, so run workers with --threads equal to
    # READINESS_WORKER_CONCURRENCY (then the wait is zero); more threads than permits would eat the time budget.
    with _CONCURRENCY:  # READINESS_WORKER_CONCURRENCY runs per worker process
        try:
            run_validation(vid)
        except TimeLimitExceeded:
            _fail(vid, f"RUN_TIMEOUT: exceeded {_SETTINGS.run_timeout_seconds}s")


# ---------------------------------------------------------------- enqueue after commit


def _send_pending(session: Session) -> None:
    for validation_id, correlation_id in session.info.pop(_PENDING, []):
        try:
            run_validation_actor.send_with_options(
                args=(str(validation_id),), correlation_id=str(correlation_id)
            )
        except Exception:  # the row stays QUEUED; the sweeper fails it after 1h and a steward can re-run
            logger.exception("could not enqueue readiness job", extra={"validation_id": str(validation_id)})


def _drop_pending(session: Session) -> None:
    session.info.pop(_PENDING, None)


def enqueue_after_commit(session: Session, validation_id: UUID, correlation_id: UUID) -> None:
    """Send the Dramatiq message only once the QUEUED row is committed (never for a rolled-back row)."""
    session.info.setdefault(_PENDING, []).append((validation_id, correlation_id))
    if not session.info.get(_LISTENING):
        event.listen(session, "after_commit", _send_pending)
        event.listen(session, "after_rollback", _drop_pending)
        session.info[_LISTENING] = True


# ---------------------------------------------------------------- sweeper


def _stale_condition(now: datetime) -> ColumnElement[bool]:
    running_cutoff = now - timedelta(seconds=_SETTINGS.run_timeout_seconds, minutes=10)
    return or_(
        (validations.c.run_status == "QUEUED") & (validations.c.created_at < now - STALE_QUEUED_AFTER),
        (validations.c.run_status == "RUNNING") & (validations.c.started_at < running_cutoff),
    )


def _stale_ids(now: datetime) -> list[UUID]:
    with _session() as session:
        return list(
            session.execute(select(validations.c.validation_id).where(_stale_condition(now))).scalars().all()
        )


def _fail_if_stale(validation_id: UUID, now: datetime) -> bool:
    """The staleness test is repeated inside the UPDATE, so a run claimed since the scan is left alone."""
    return fail_run(
        validation_id,
        "STALE_JOB: no progress within the allowed time",
        from_statuses=("QUEUED", "RUNNING"),
        guard=_stale_condition(now),
    )


def sweep_stale() -> int:
    """QUEUED > 1h, RUNNING > run timeout + 10 min -> FAILED(STALE_JOB) + completed event."""
    now = clock.now()
    return sum(_fail_if_stale(vid, now) for vid in _stale_ids(now))


def register_worker(broker: dramatiq.Broker, scheduler: Scheduler) -> None:
    """ModuleSpec.register_worker: the actor was declared on the broker at import; add the sweeper."""
    if run_validation_actor.broker is not broker:
        raise RuntimeError("configure the Dramatiq broker before importing api.modules.readiness (D-036)")
    scheduler.every(SWEEP_INTERVAL_S, "readiness.sweep_stale", _sweep_job)


def _sweep_job() -> None:
    swept = sweep_stale()
    if swept:
        logger.warning("stale readiness runs failed", extra={"count": swept})
