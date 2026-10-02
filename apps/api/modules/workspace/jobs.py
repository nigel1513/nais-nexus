"""Dramatiq actor `workspace.run_recipe` (queue `workspace`), the stale-run sweeper and enqueue-after-commit.

One delivery: claim QUEUED -> RUNNING (attempt+1) -> re-check the starter's access to every pinned input -> read
the inputs the steps need (pinned dataset versions, row/byte caps) -> apply the pinned recipe version -> write the
result as Parquet to a temporary file -> upload it to the project lead organization's bucket at
workspace/{project_id}/outputs/{output_id}/result.parquet -> one transaction: DERIVED_DATASET output (READY, lineage =
pinned inputs + recipe@version + run) + run SUCCEEDED + workspace.run.succeeded.v1 + workspace.output.created.v1.
Failures end the run FAILED with a short summary (`CODE: text`, no stack trace, no data values, <= 500 chars) and
workspace.run.failed.v1. Storage/database outages are retried (3 attempts in all) before failing.
Sweeper (every 10 min): RUNNING past the time limit + 10 min -> FAILED; QUEUED with no message sent for 1 h -> the
message is re-sent (duplicates are harmless); QUEUED for 24 h -> FAILED as a last resort.
No database transaction is held while reading, computing or uploading.

The actor is defined at import time: the platform sets the broker BEFORE importing modules (D-036).
"""

import hashlib
import logging
import tempfile
import traceback
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any
from uuid import UUID

import dramatiq
import pyarrow as pa
import pyarrow.parquet as pq
from dramatiq.middleware import TimeLimitExceeded
from sqlalchemy import event
from sqlalchemy.engine import RowMapping
from sqlalchemy.exc import InterfaceError, OperationalError
from sqlalchemy.orm import Session

from api.modules.catalog.public import DatasetPolicyView, ObjectMissing, StorageUnavailable
from api.modules.workspace import repo
from api.modules.workspace.access import dataset_access
from api.modules.workspace.deps import WorkspaceDeps
from api.modules.workspace.recipes import reader, steps
from api.modules.workspace.recipes.model import parse_steps
from api.modules.workspace.service.outputs import NO_INPUTS_FLOOR, STRICTNESS
from api.modules.workspace.settings import get_workspace_settings
from api.platform import clock, ports
from api.platform.db import session_factory
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.generated.event_types import EventType
from api.platform.ids import new_id
from api.platform.outbox import outbox
from api.platform.scheduler import Scheduler

logger = logging.getLogger("nais.workspace")
QUEUE = "workspace"
MAX_ATTEMPTS = 3
RESEND_QUEUED_AFTER_S = (
    3600  # a QUEUED run whose message is older than this is sent again (claims are idempotent)
)
ABANDON_QUEUED_AFTER_S = 24 * 3600  # last resort: a run QUEUED this long is failed
SWEEP_INTERVAL_S = 600.0
RESULT_NAME = "result.parquet"
RESULT_MEDIA_TYPE = "application/vnd.apache.parquet"
_PENDING = "workspace.pending_runs"
_LISTENING = "workspace.listening"
_SETTINGS = get_workspace_settings()
DB_ERRORS = (OperationalError, InterfaceError)


@dataclass
class Runtime:
    """Tests point the job at their database; production uses Settings (None)."""

    database_url: str | None = None


RUNTIME = Runtime()


class RetryableInfraError(Exception):
    """Raised after putting the run back to QUEUED so Dramatiq redelivers it."""


class RunFailed(Exception):  # noqa: N818
    """A run ends FAILED with this summary (already free of data values)."""


class _Superseded(Exception):  # noqa: N818
    """The run left RUNNING while we worked (swept as stale): discard the result."""


def _session() -> Session:
    return session_factory(RUNTIME.database_url)()


def summary(code: str, text: str) -> str:
    return f"{code}: {text}"[:500]


def _actor(run: RowMapping) -> EventActor:
    return EventActor(
        type="USER", user_id=run["started_by"], organization_id=run["started_by_organization_id"]
    )


def _recipe_name(session: Session, run: RowMapping) -> str:
    version = repo.load_recipe_version(session, run["recipe_id"], run["recipe_version"])
    return version["name"] if version else ""


# ---------------------------------------------------------------- transitions


def claim(run_id: UUID) -> RowMapping | None:
    """QUEUED -> RUNNING (attempt+1). None when not QUEUED (duplicate delivery, already finished)."""
    with _session() as session, session.begin():
        current = repo.load_run_by_id(session, run_id)
        if current is None:
            return None
        return repo.update_run(
            session,
            run_id,
            from_statuses=("QUEUED",),
            status="RUNNING",
            started_at=clock.now(),
            attempt=current["attempt"] + 1,
        )


def _requeue(run_id: UUID) -> None:
    """RUNNING -> QUEUED for an infrastructure retry; the wait is measured afresh from now."""
    now = clock.now()
    with _session() as session, session.begin():
        repo.update_run(
            session, run_id, from_statuses=("RUNNING",), status="QUEUED", queued_at=now, last_enqueued_at=now
        )


def _failed_event(session: Session, run: RowMapping) -> None:
    outbox.write(
        session,
        EventType.WORKSPACE_RUN_FAILED_V1,
        {
            "project_id": str(run["project_id"]),
            "actor_id": str(run["started_by"]),
            "occurred_at": run["finished_at"].isoformat(),
            "run_id": str(run["run_id"]),
            "recipe_id": str(run["recipe_id"]),
            "recipe_name": _recipe_name(session, run),
            "recipe_version": run["recipe_version"],
            "error": run["error"],
        },
        _actor(run),
    )


def fail_run(run_id: UUID, error: str) -> str:
    """RUNNING -> FAILED + workspace.run.failed.v1. "FAILED", or "SKIPPED" when the run had already ended."""
    with _session() as session, session.begin():
        row = repo.update_run(
            session,
            run_id,
            from_statuses=("RUNNING",),
            status="FAILED",
            error=error[:500],
            finished_at=clock.now(),
        )
        if row is None:
            return "SKIPPED"
        _failed_event(session, row)
        return "FAILED"


# ---------------------------------------------------------------- the work


@dataclass(frozen=True)
class _Context:
    run: RowMapping
    input_ids: list[UUID]
    steps: list[Any]
    recipe_name: str
    pinned: list[RowMapping]


def _context(run: RowMapping) -> _Context:
    with _session() as session:
        version = repo.load_recipe_version(session, run["recipe_id"], run["recipe_version"])
        pinned = repo.pinned_inputs(session, run["run_id"])
    if version is None:  # FK guarantees it; defensive
        raise RunFailed(summary("RECIPE_MISSING", "the pinned recipe version does not exist"))
    return _Context(run, list(version["input_ids"]), parse_steps(version["steps"]), version["name"], pinned)


def _policies(deps: WorkspaceDeps, ctx: _Context) -> dict[UUID, DatasetPolicyView]:
    """Current policies of the pinned inputs; the starter must still be allowed to use every one."""
    policies: dict[UUID, DatasetPolicyView] = {}
    lapsed = 0
    for p in ctx.pinned:
        policy = deps.catalog.get_policy_view(p["dataset_id"])
        if policy is None or not dataset_access(
            deps, ctx.run["started_by"], ctx.run["started_by_organization_id"], policy
        ):
            lapsed += 1
            continue
        policies[p["input_id"]] = policy
    if lapsed:
        raise RunFailed(
            summary(
                "INPUT_ACCESS_LAPSED", f"access to {lapsed} input(s) was revoked or expired before the run"
            )
        )
    return policies


def _read_inputs(deps: WorkspaceDeps, ctx: _Context) -> dict[UUID, pa.Table]:
    by_id = {p["input_id"]: p for p in ctx.pinned}
    tables: dict[UUID, pa.Table] = {}
    for input_id in steps.needed_inputs(ctx.steps, ctx.input_ids):
        pin = by_id.get(input_id)
        if pin is None:
            raise RunFailed(summary("RECIPE_INVALID", "a join step reads an input that is not in the recipe"))
        label = f"input '{pin['dataset_title']}' {pin['version_label']}"
        version = deps.catalog.get_version(pin["dataset_version_id"])
        if version is None or version.status != "PUBLISHED":
            raise RunFailed(summary("INPUT_UNAVAILABLE", f"{label} is no longer published"))
        file = reader.primary_file(version)
        if file is None:
            raise RunFailed(summary("INPUT_NOT_TABULAR", f"{label} has no CSV or Parquet file"))
        try:
            tables[input_id] = reader.read_table(
                deps.reader,
                file,
                max_rows=_SETTINGS.workspace_max_rows,
                truncate=False,
                max_bytes=_SETTINGS.workspace_max_input_bytes,
            ).table
        except reader.InputTooLarge as exc:
            raise RunFailed(summary("INPUT_TOO_LARGE", f"{label}: {exc}")) from exc
        except reader.InputUnreadable as exc:
            raise RunFailed(summary("INPUT_UNREADABLE", f"{label}: {exc}")) from exc
        except ObjectMissing as exc:
            raise RunFailed(summary("INPUT_UNAVAILABLE", f"{label}: the file is missing in storage")) from exc
    return tables


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def _lead_org_code(deps: WorkspaceDeps, project_id: UUID) -> str:
    summary_ = deps.projects.get_summary(project_id)
    code = deps.people.get_organization_code(summary_.lead_organization_id.root) if summary_ else None
    if code is None:
        raise RunFailed(summary("STORAGE_NOT_CONFIGURED", "the project's lead organization has no storage"))
    return code


def _finish(
    ctx: _Context, *, output: dict[str, Any], file: dict[str, Any], input_rows: int, output_rows: int
) -> None:
    """One transaction: output + lineage, run SUCCEEDED (guarded), both events."""
    run = ctx.run
    now = clock.now()
    with _session() as session, session.begin():
        repo.insert_output(
            session,
            output | {"created_at": now, "started_at": now},
            [file],
            [
                {
                    k: p[k]
                    for k in (
                        "input_id",
                        "dataset_id",
                        "dataset_version_id",
                        "dataset_title",
                        "version_label",
                    )
                }
                for p in ctx.pinned
            ],
        )
        done = repo.update_run(
            session,
            run["run_id"],
            from_statuses=("RUNNING",),
            status="SUCCEEDED",
            finished_at=now,
            input_rows=input_rows,
            output_rows=output_rows,
            output_id=output["output_id"],
        )
        if done is None:
            raise _Superseded()
        common = {
            "project_id": str(run["project_id"]),
            "actor_id": str(run["started_by"]),
            "occurred_at": now.isoformat(),
        }
        outbox.write(
            session,
            EventType.WORKSPACE_RUN_SUCCEEDED_V1,
            common
            | {
                "run_id": str(run["run_id"]),
                "recipe_id": str(run["recipe_id"]),
                "recipe_name": ctx.recipe_name,
                "recipe_version": run["recipe_version"],
                "input_rows": input_rows,
                "output_rows": output_rows,
                "output_id": str(output["output_id"]),
            },
            _actor(run),
        )
        outbox.write(
            session,
            EventType.WORKSPACE_OUTPUT_CREATED_V1,
            common
            | {
                "output_id": str(output["output_id"]),
                "output_title": output["title"],
                "kind": output["kind"],
                "access_level": output["access_level"],
                "run_id": str(run["run_id"]),
                "lineage_dataset_version_ids": [str(p["dataset_version_id"]) for p in ctx.pinned],
            },
            _actor(run),
        )


def _execute(run: RowMapping) -> None:
    deps = ports.get(WorkspaceDeps)
    ctx = _context(run)
    policies = _policies(deps, ctx)
    tables = _read_inputs(deps, ctx)
    input_rows = sum(t.num_rows for t in tables.values())
    try:
        result = steps.apply(ctx.steps, tables, ctx.input_ids, max_rows=_SETTINGS.workspace_max_rows)
    except steps.StepError as exc:
        raise RunFailed(summary("RECIPE_INVALID", exc.message)) from exc
    del tables
    output_rows = result.num_rows
    org_code = _lead_org_code(deps, run["project_id"])
    output_id = new_id()
    key = f"workspace/{run['project_id']}/outputs/{output_id}/{RESULT_NAME}"
    with tempfile.TemporaryDirectory(prefix="nais-run-") as tmp:
        path = Path(tmp) / RESULT_NAME
        pq.write_table(result, path, compression="zstd")
        del result
        size = path.stat().st_size
        sha = _sha256(path)
        deps.storage.put_file(org_code, key, str(path), RESULT_MEDIA_TYPE)
    access_level = max(
        (p.access_level for p in policies.values()), key=STRICTNESS.index, default=NO_INPUTS_FLOOR
    )
    title = f"{ctx.recipe_name} (v{run['recipe_version']})"
    _finish(
        ctx,
        output={
            "output_id": output_id,
            "project_id": run["project_id"],
            "kind": "DERIVED_DATASET",
            "title": title[:300],
            "access_level": access_level,
            "status": repo.READY,
            "storage_org_code": org_code,
            "produced_by_run_id": run["run_id"],
            "recipe_id": run["recipe_id"],
            "recipe_version": run["recipe_version"],
            "created_by": run["started_by"],
        },
        file={
            "name": RESULT_NAME,
            "size_bytes": size,
            "sha256": sha,
            "media_type": RESULT_MEDIA_TYPE,
            "object_key": key,
        },
        input_rows=input_rows,
        output_rows=output_rows,
    )


def _retryable(exc: BaseException) -> bool:
    if isinstance(exc, StorageUnavailable | ports.PortNotProvided | OperationalError | InterfaceError):
        return True
    return isinstance(exc, ApiError) and exc.code == ErrorCode.DEPENDENCY_UNAVAILABLE


def run_recipe(run_id: UUID) -> str:
    """One delivery. Returns the resulting status, or "SKIPPED" when there was nothing to do."""
    try:
        run = claim(run_id)
    except DB_ERRORS as exc:  # nothing claimed: still QUEUED, let Dramatiq redeliver
        raise RetryableInfraError(type(exc).__name__) from exc
    if run is None:
        return "SKIPPED"
    try:
        _execute(run)
    except RunFailed as exc:
        return fail_run(run_id, str(exc))
    except _Superseded:
        logger.warning("run left RUNNING during execution", extra={"run_id": str(run_id)})
        return "SKIPPED"
    except MemoryError:
        return fail_run(
            run_id, summary("OUT_OF_MEMORY", "the run needed more memory than available; use fewer rows")
        )
    except Exception as exc:
        if _retryable(exc):
            if run["attempt"] < MAX_ATTEMPTS:
                _requeue(run_id)
                raise RetryableInfraError(type(exc).__name__) from exc
            return fail_run(
                run_id, summary("STORAGE_UNAVAILABLE", f"{type(exc).__name__} after {MAX_ATTEMPTS} attempts")
            )
        # the exception message may quote data values: log its type and frames only
        logger.error(
            "recipe run crashed",
            extra={
                "run_id": str(run_id),
                "error_type": type(exc).__name__,
                "traceback": _frames(exc),
            },
        )
        return fail_run(run_id, summary("INTERNAL_ERROR", type(exc).__name__))
    return "SUCCEEDED"


def _frames(exc: BaseException) -> str:
    """Where it failed (file:line in function), without the message or source lines (either may quote data)."""
    return " <- ".join(
        f"{Path(f.filename).name}:{f.lineno} in {f.name}"
        for f in reversed(traceback.extract_tb(exc.__traceback__))
    )


def _retry_when(retries: int, exc: BaseException) -> bool:
    return isinstance(exc, RetryableInfraError) and retries < MAX_ATTEMPTS - 1


@dramatiq.actor(
    actor_name="workspace.run_recipe",
    queue_name=QUEUE,
    max_retries=MAX_ATTEMPTS - 1,
    retry_when=_retry_when,
    min_backoff=2_000,
    max_backoff=60_000,
    time_limit=_SETTINGS.workspace_run_timeout_seconds * 1000,
)
def run_recipe_actor(run_id: str) -> None:
    rid = UUID(run_id)
    try:
        run_recipe(rid)
    except TimeLimitExceeded:
        fail_run(rid, summary("RUN_TIMEOUT", f"exceeded {_SETTINGS.workspace_run_timeout_seconds}s"))


# ---------------------------------------------------------------- enqueue after commit


def _send_pending(session: Session) -> None:
    for run_id in session.info.pop(_PENDING, []):
        try:
            run_recipe_actor.send(str(run_id))
        except Exception:  # the row stays QUEUED; the sweeper fails it after an hour
            logger.exception("could not enqueue recipe run", extra={"run_id": str(run_id)})


def _drop_pending(session: Session) -> None:
    session.info.pop(_PENDING, None)


def enqueue_after_commit(session: Session, run_id: UUID) -> None:
    """Send the Dramatiq message only once the QUEUED row is committed (never for a rolled-back row)."""
    session.info.setdefault(_PENDING, []).append(run_id)
    if not session.info.get(_LISTENING):
        event.listen(session, "after_commit", _send_pending)
        event.listen(session, "after_rollback", _drop_pending)
        session.info[_LISTENING] = True


# ---------------------------------------------------------------- sweeper


def resend_waiting() -> int:
    """Re-send the message of every run QUEUED for over an hour since its last send. A legitimately waiting run
    (busy single-concurrency queue) loses nothing: a duplicate delivery is SKIPPED by the guarded claim; a lost
    message (broker restart, failed send after commit) gets its run going again."""
    now = clock.now()
    sent_before = now - timedelta(seconds=RESEND_QUEUED_AFTER_S)
    with _session() as session:
        ids = repo.waiting_run_ids(session, sent_before=sent_before)
    resent = 0
    for run_id in ids:
        with _session() as session, session.begin():
            marked = repo.mark_resent(session, run_id, sent_before=sent_before, at=now)
        if marked:
            try:
                run_recipe_actor.send(str(run_id))
                resent += 1
            except Exception:
                logger.error("could not re-send recipe run", extra={"run_id": str(run_id)})
    return resent


def sweep_stale() -> int:
    """QUEUED > 24 h (last resort) or RUNNING > run timeout + 10 min -> FAILED(STALE_RUN) + run.failed event."""
    now = clock.now()
    queued_before = now - timedelta(seconds=ABANDON_QUEUED_AFTER_S)
    running_before = now - timedelta(seconds=_SETTINGS.workspace_run_timeout_seconds, minutes=10)
    with _session() as session:
        ids = repo.stale_run_ids(session, queued_before=queued_before, running_before=running_before)
    swept = 0
    for run_id in ids:
        with _session() as session, session.begin():
            row = repo.fail_if_stale(
                session,
                run_id,
                queued_before=queued_before,
                running_before=running_before,
                error=summary("STALE_RUN", "no progress within the allowed time"),
                at=now,
            )
            if row is not None:
                _failed_event(session, row)
                swept += 1
    return swept


def _sweep_job() -> None:
    swept = sweep_stale()
    if swept:
        logger.warning("stale recipe runs failed", extra={"count": swept})
    resent = resend_waiting()
    if resent:
        logger.info("waiting recipe runs re-sent", extra={"count": resent})


# ---------------------------------------------------------------- hub publication (service/publish.py)

PUBLISH_QUEUE = "workspace_publish"  # general worker pool: never waits behind the single-slot recipe queue
PUBLISH_TIME_LIMIT_MS = 20 * 60 * 1000  # below service.publish.LEASE, so a lease never outlives its delivery
PUBLISH_RESEND_AFTER_S = 60  # a pending publication not attempted for this long is sent again
PUBLISH_SWEEP_INTERVAL_S = 60.0
_PENDING_PUBLISH = "workspace.pending_publications"
_LISTENING_PUBLISH = "workspace.listening_publications"


def job_session() -> Session:
    """A session on the job database (tests point RUNTIME at theirs)."""
    return _session()


@dramatiq.actor(
    actor_name="workspace.publish_output",
    queue_name=PUBLISH_QUEUE,
    max_retries=0,  # the sweeper re-sends pending publications; the lease makes duplicates harmless
    time_limit=PUBLISH_TIME_LIMIT_MS,
)
def publish_output_actor(request_id: str) -> None:
    from api.modules.workspace.service.publish import publish_approved  # noqa: PLC0415 (service imports jobs)

    publish_approved(UUID(request_id))


def _send_publications(session: Session) -> None:
    for request_id in session.info.pop(_PENDING_PUBLISH, []):
        try:
            publish_output_actor.send(str(request_id))
        except Exception:  # the request stays pending; the sweeper sends it within a minute
            logger.exception("could not enqueue publication", extra={"request_id": str(request_id)})


def _drop_publications(session: Session) -> None:
    session.info.pop(_PENDING_PUBLISH, None)


def enqueue_publication_after_commit(session: Session, request_id: UUID) -> None:
    session.info.setdefault(_PENDING_PUBLISH, []).append(request_id)
    if not session.info.get(_LISTENING_PUBLISH):
        event.listen(session, "after_commit", _send_publications)
        event.listen(session, "after_rollback", _drop_publications)
        session.info[_LISTENING_PUBLISH] = True


def resend_publications() -> int:
    """Send every pending, unleased publication not attempted for a minute: a lost message, a catalog still
    verifying files (DRAFT), a storage outage or an expired lease (worker died)."""
    now = clock.now()
    with _session() as session:
        ids = repo.publications_due(
            session, now=now, attempted_before=now - timedelta(seconds=PUBLISH_RESEND_AFTER_S)
        )
    sent = 0
    for request_id in ids:
        try:
            publish_output_actor.send(str(request_id))
            sent += 1
        except Exception:
            logger.error("could not re-send publication", extra={"request_id": str(request_id)})
    return sent


def _publish_sweep_job() -> None:
    sent = resend_publications()
    if sent:
        logger.info("pending publications sent", extra={"count": sent})


def register_worker(broker: dramatiq.Broker, scheduler: Scheduler) -> None:
    """ModuleSpec.register_worker: the actors were declared on the broker at import; add the sweepers."""
    if run_recipe_actor.broker is not broker or publish_output_actor.broker is not broker:
        raise RuntimeError("configure the Dramatiq broker before importing api.modules.workspace (D-036)")
    scheduler.every(SWEEP_INTERVAL_S, "workspace.sweep_stale_runs", _sweep_job)
    scheduler.every(PUBLISH_SWEEP_INTERVAL_S, "workspace.resend_publications", _publish_sweep_job)
