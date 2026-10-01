"""Catalog background work (M03 §10). The verify actor is declared at import time (D-036)."""

import logging
from uuid import UUID

import dramatiq
from sqlalchemy import select

from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.objects import StorageUnavailable
from api.modules.catalog.tables import dataset_files
from api.modules.catalog.verification import apply_outcome, evaluate_object
from api.platform import ports

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
        applied = apply_outcome(session, file_id, outcome)
    if not applied:
        return None
    if outcome.failed:
        try:
            store.delete(row["storage_key"])
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
