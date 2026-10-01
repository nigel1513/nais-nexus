"""Background jobs (spec §10): identity.prune_sessions, daily, deletes user_sessions older than 90 days."""

import logging
from datetime import datetime, timedelta
from typing import Any, cast

import dramatiq
from sqlalchemy import CursorResult, delete
from sqlalchemy.orm import Session

from api.modules.identity.resolver import SessionFactory
from api.modules.identity.tables import user_sessions
from api.platform import clock
from api.platform.db import session_scope
from api.platform.scheduler import Scheduler

logger = logging.getLogger("nais.identity.jobs")

RETENTION = timedelta(days=90)
PRUNE_INTERVAL_S = 86400.0


def prune_sessions(session: Session, *, now: datetime) -> int:
    result = cast(
        CursorResult[Any],
        session.execute(delete(user_sessions).where(user_sessions.c.first_seen_at < now - RETENTION)),
    )
    return result.rowcount


def run_prune_sessions(sessions: SessionFactory = session_scope) -> None:
    with sessions() as session:
        deleted = prune_sessions(session, now=clock.now())
    logger.info("pruned identity sessions", extra={"deleted": deleted})


def register_worker(broker: dramatiq.Broker, scheduler: Scheduler) -> None:
    scheduler.every(PRUNE_INTERVAL_S, "identity.prune_sessions", run_prune_sessions, run_immediately=True)
