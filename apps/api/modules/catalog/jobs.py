"""Catalog background work (M03 §10). The verify and preview actors are declared at import time (D-036)."""

import logging
from collections.abc import Mapping
from datetime import timedelta
from typing import Any
from uuid import UUID

import dramatiq
from sqlalchemy import select, update

from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.objects import StorageUnavailable
from api.modules.catalog.previews.jobs import DISPATCH_INTERVAL_S, dispatch_previews
from api.modules.catalog.previews.sandbox import protect_worker_environ
from api.modules.catalog.search.drain import drain_index_queue
from api.modules.catalog.service.uploads import abort_quietly
from api.modules.catalog.tables import dataset_files, dataset_versions, upload_sessions
from api.modules.catalog.verification import apply_outcome, evaluate_object
from api.platform import clock, ports
from api.platform.scheduler import Scheduler

logger = logging.getLogger("nais.catalog.jobs")

VERIFY_TIME_LIMIT_MS = 2 * 60 * 60 * 1000
VERIFY_MAX_RETRIES = 3


def verify_file_job(file_id: UUID, *, deps: CatalogDeps) -> str | None:
    """Idempotent: only an UPLOADED row is evaluated and updated (at-least-once delivery).

    StorageUnavailable (retried by the actor) or a scanner error propagates before any write, so the row stays
    UPLOADED and the stale re-queue sweep picks it up if retries are exhausted."""
    with deps.session_factory() as session:
        row = (
            session.execute(select(dataset_files).where(dataset_files.c.file_id == file_id))
            .mappings()
            .first()
        )
    if row is None or row["status"] != "UPLOADED":
        return None
    store = deps.storage.for_bucket(row["storage_bucket"])
    outcome = evaluate_object(
        store,
        key=row["storage_key"],
        size=int(row["size_bytes"]),
        sha256=row["sha256"],
        path=row["path"],
        scanner=deps.scanner,
    )
    with deps.session_factory() as session, session.begin():
        # Global lock order: version -> upload session -> file (as completeUploadSession / deleteDraftFile).
        session.execute(
            select(dataset_versions.c.dataset_version_id)
            .where(dataset_versions.c.dataset_version_id == row["dataset_version_id"])
            .with_for_update(read=True)
        )
        applied = apply_outcome(session, file_id, row["upload_session_id"], outcome)
    if not applied:
        return None
    if outcome.failed:
        try:
            store.delete(row["storage_key"])  # session-owned key (D-039): never shared with an inherited row
        except StorageUnavailable:
            logger.warning("could not delete failed object", extra={"file_id": str(file_id)}, exc_info=True)
    logger.info(
        "catalog file verified",
        extra={"file_id": str(file_id), "status": outcome.status, "failure_code": outcome.failure_code},
    )
    return outcome.status


def _retry_when(retries: int, exc: BaseException) -> bool:
    return retries < VERIFY_MAX_RETRIES and isinstance(exc, StorageUnavailable)


@dramatiq.actor(
    queue_name="catalog",
    actor_name="catalog.verify_file",
    time_limit=VERIFY_TIME_LIMIT_MS,
    retry_when=_retry_when,
)
def verify_file_actor(file_id: str) -> None:
    verify_file_job(UUID(file_id), deps=ports.get(CatalogDeps))


DRAIN_INTERVAL_S = 2.0
SWEEP_INTERVAL_S = 300.0


def _cleanup_partial_upload(deps: CatalogDeps, f: Mapping[Any, Any]) -> None:
    try:
        store = deps.storage.for_bucket(f["storage_bucket"])
        if f["multipart_upload_id"]:
            abort_quietly(store, f["storage_key"], f["multipart_upload_id"])
        store.delete(f["storage_key"])  # session-owned key (D-039): never shared with an inherited row
    except Exception:
        logger.warning(
            "could not clean up an expired upload", extra={"file_id": str(f["file_id"])}, exc_info=True
        )


def _expire_one(
    deps: CatalogDeps, upload_session_id: UUID, version_id: UUID
) -> list[Mapping[Any, Any]] | None:
    """Lock order matches completeUploadSession: version -> session -> files (all SKIP LOCKED, then re-check).

    Only DB state changes inside the transaction; the caller cleans storage after commit."""
    now = clock.now()
    with deps.session_factory() as session, session.begin():
        locked_version = session.execute(
            select(dataset_versions.c.dataset_version_id)
            .where(dataset_versions.c.dataset_version_id == version_id)
            .with_for_update(skip_locked=True)
        ).first()
        if locked_version is None:
            return None  # a writer holds the version; retry on the next sweep
        sess = session.execute(
            select(upload_sessions.c.upload_session_id)
            .where(
                upload_sessions.c.upload_session_id == upload_session_id,
                upload_sessions.c.status == "OPEN",
                upload_sessions.c.expires_at < now,
            )
            .with_for_update(skip_locked=True)
        ).first()
        if sess is None:
            return None  # completed or expired meanwhile
        pending = (
            session.execute(
                select(dataset_files)
                .where(
                    dataset_files.c.upload_session_id == upload_session_id,
                    dataset_files.c.status == "PENDING",
                )
                .with_for_update()
            )
            .mappings()
            .all()
        )
        if pending:
            session.execute(
                update(dataset_files)
                .where(dataset_files.c.file_id.in_([f["file_id"] for f in pending]))
                .values(status="FAILED", failure_code="SESSION_EXPIRED", updated_at=now)
            )
        session.execute(
            update(upload_sessions)
            .where(upload_sessions.c.upload_session_id == upload_session_id)
            .values(status="EXPIRED")
        )
    return list(pending)


def expire_upload_sessions(deps: CatalogDeps, *, limit: int = 100) -> int:
    """catalog.expire_upload_sessions (M03 §5.3, §10)."""
    with deps.session_factory() as session:
        candidates = session.execute(
            select(upload_sessions.c.upload_session_id, upload_sessions.c.dataset_version_id)
            .where(upload_sessions.c.status == "OPEN", upload_sessions.c.expires_at < clock.now())
            .order_by(upload_sessions.c.expires_at)
            .limit(limit)
        ).all()
    expired = 0
    for sid, vid in candidates:
        pending = _expire_one(deps, sid, vid)
        if pending is None:
            continue
        expired += 1
        for f in pending:  # after commit: a slow store never holds DB locks
            _cleanup_partial_upload(deps, f)
    if expired:
        logger.info("expired upload sessions", extra={"count": expired})
    return expired


def requeue_stale_uploads(
    deps: CatalogDeps, *, older_than: timedelta = timedelta(hours=2), limit: int = 500
) -> int:
    """Re-send UPLOADED files left behind by a lost verify message or an exhausted/dead-lettered verify run."""
    now = clock.now()
    with deps.session_factory() as session, session.begin():
        # Global lock order: version -> upload session -> file. Candidates are read unlocked, their versions locked
        # (skipping versions a writer holds), and only then the file rows.
        candidates = session.execute(
            select(dataset_files.c.file_id, dataset_files.c.dataset_version_id)
            .where(dataset_files.c.status == "UPLOADED", dataset_files.c.updated_at < now - older_than)
            .limit(limit)
        ).all()
        locked_versions: list[UUID] = list(
            session.execute(
                select(dataset_versions.c.dataset_version_id)
                .where(dataset_versions.c.dataset_version_id.in_({vid for _, vid in candidates}))
                .order_by(dataset_versions.c.dataset_version_id)
                .with_for_update(read=True, skip_locked=True)
            ).scalars()
        )
        file_ids: list[UUID] = list(
            session.execute(
                select(dataset_files.c.file_id)
                .where(
                    dataset_files.c.file_id.in_([fid for fid, _ in candidates]),
                    dataset_files.c.dataset_version_id.in_(locked_versions),
                    dataset_files.c.status == "UPLOADED",
                    dataset_files.c.updated_at < now - older_than,
                )
                .with_for_update(skip_locked=True)
            ).scalars()
        )
        if file_ids:
            session.execute(
                update(dataset_files).where(dataset_files.c.file_id.in_(file_ids)).values(updated_at=now)
            )
    if file_ids:
        # updated_at was bumped above; if enqueue fails the retry is deferred to the next older_than window.
        deps.verification.enqueue(file_ids)
        logger.warning("re-queued stale file verifications", extra={"count": len(file_ids)})
    return len(file_ids)


def _deps() -> CatalogDeps:
    return ports.get(CatalogDeps)


def _drain() -> None:
    drain_index_queue(_deps())


def _sweep() -> None:
    deps = _deps()
    try:
        expire_upload_sessions(deps)
    except Exception:
        logger.exception("expire_upload_sessions failed")
    try:
        requeue_stale_uploads(deps)
    except Exception:
        logger.exception("requeue_stale_uploads failed")


def _dispatch_previews() -> None:
    try:
        dispatch_previews(_deps())
    except Exception:
        logger.exception("dispatch_previews failed")


def register_worker(broker: dramatiq.Broker, scheduler: Scheduler) -> None:
    if not protect_worker_environ():  # profiling children must not read this process's secrets
        logger.warning("could not mark the worker non-dumpable; preview children may read its environment")
    scheduler.every(DRAIN_INTERVAL_S, "catalog.index_drain", _drain)
    scheduler.every(SWEEP_INTERVAL_S, "catalog.expire_upload_sessions", _sweep)
    scheduler.every(DISPATCH_INTERVAL_S, "catalog.preview_dispatch", _dispatch_previews)
