"""catalog.index_drain (M03 §10): index_queue -> OpenSearch, every 2 s in the worker."""

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import delete, select, update
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.search.documents import build_documents, embed_documents
from api.modules.catalog.tables import index_queue
from api.platform import clock

logger = logging.getLogger("nais.catalog.index")
ALERT_AFTER_ATTEMPTS = 10


@dataclass(frozen=True)
class DrainResult:
    indexed: int = 0
    deleted: int = 0
    failed: int = 0


def backoff_seconds(attempts: int) -> float:
    return float(min(2**attempts, 300))


def _record_failure(session: Session, queued: Sequence[RowMapping], now: datetime, exc: Exception) -> None:
    for row in queued:
        attempts = int(row["attempts"]) + 1
        session.execute(
            update(index_queue)
            .where(index_queue.c.dataset_id == row["dataset_id"])
            .values(attempts=attempts, next_attempt_at=now + timedelta(seconds=backoff_seconds(attempts)))
        )
        if attempts > ALERT_AFTER_ATTEMPTS:
            logger.error(
                "catalog index drain keeps failing",
                extra={
                    "dataset_id": str(row["dataset_id"]),
                    "attempts": attempts,
                    "metric": "catalog_index_drain_failures",
                    "error": str(exc)[:500],
                },
            )
    logger.warning(
        "catalog index drain failed; will retry", extra={"datasets": len(queued), "error": str(exc)[:500]}
    )


def drain_index_queue(deps: CatalogDeps, *, batch_size: int | None = None) -> DrainResult:
    limit = batch_size or deps.settings.catalog_index_batch_size
    now = clock.now()
    with deps.session_factory() as session, session.begin():
        queued = (
            session.execute(
                select(index_queue)
                .where(index_queue.c.next_attempt_at <= now)
                .order_by(index_queue.c.enqueued_at)
                .limit(limit)
                .with_for_update(skip_locked=True)
            )
            .mappings()
            .all()
        )
        if not queued:
            return DrainResult()
        ids = [row["dataset_id"] for row in queued]
        try:
            docs, deletes = build_documents(session, deps.organizations, ids)
            if deps.embedder is not None and deps.search.supports_vectors():
                embed_documents(docs, deps.embedder)
            deps.search.bulk(docs, deletes)
        except Exception as exc:  # OpenSearch or identity down: keep the rows, retry later
            _record_failure(session, queued, now, exc)
            return DrainResult(failed=len(queued))
        session.execute(delete(index_queue).where(index_queue.c.dataset_id.in_(ids)))
        return DrainResult(indexed=len(docs), deleted=len(deletes))
