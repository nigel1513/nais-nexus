"""Worker wiring (spec §10). The actor is declared here, not at import time, so it binds to the worker's broker."""

import logging
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any, cast

import dramatiq
from sqlalchemy import CursorResult, delete, select
from sqlalchemy.orm import Session

from api.modules.audit.email import send_pending_emails_job
from api.modules.audit.email_queue import set_send_actor
from api.modules.audit.settings import AuditSettings, get_audit_settings
from api.modules.audit.tables import notifications
from api.platform import clock
from api.platform.db import session_factory
from api.platform.scheduler import Scheduler

logger = logging.getLogger("nais.audit")
SEND_ACTOR_NAME = "audit_send_emails"
EMAIL_RETRY_INTERVAL_S = 300.0
PURGE_INTERVAL_S = 86400.0
PURGE_BATCH_SIZE = 500


def purge_notifications(
    factory: Callable[[], Session],
    settings: AuditSettings,
    *,
    now: Callable[[], datetime] = clock.now,
    batch_size: int = PURGE_BATCH_SIZE,
) -> int:
    """Delete READ notifications older than NOTIFICATION_RETENTION_DAYS (email rows cascade), in short batches.

    Never touches audit_events (append-only).
    """
    cutoff = now() - timedelta(days=settings.notification_retention_days)
    n = notifications.c
    total = 0
    while True:
        with factory() as session, session.begin():
            ids = (
                select(n.notification_id)
                .where(n.read_at.is_not(None), n.created_at < cutoff)
                .limit(batch_size)
                .with_for_update(skip_locked=True)
            )
            result = cast(
                CursorResult[Any], session.execute(delete(notifications).where(n.notification_id.in_(ids)))
            )
            deleted = result.rowcount
        total += deleted
        if deleted < batch_size:
            return total


def _purge_job() -> None:
    deleted = purge_notifications(session_factory(), get_audit_settings())
    logger.info("purged read notifications", extra={"deleted": deleted})


def register_worker(broker: dramatiq.Broker, scheduler: Scheduler) -> None:
    actor = dramatiq.actor(broker=broker, actor_name=SEND_ACTOR_NAME)(send_pending_emails_job)
    set_send_actor(actor)
    # The scan sends every PENDING row that is due: never-kicked (lost enqueue) and backoff retries alike.
    scheduler.every(EMAIL_RETRY_INTERVAL_S, "audit.send_emails", send_pending_emails_job)
    scheduler.every(PURGE_INTERVAL_S, "audit.purge_notifications", _purge_job)
