"""Outbox relay: locks due rows (SKIP LOCKED), runs each handler in its own transaction, records outcome."""

import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from api.platform import clock
from api.platform.context import use_correlation_id
from api.platform.event_bus import HandlerRegistry
from api.platform.events import EventEnvelope
from api.platform.outbox import outbox_events

logger = logging.getLogger("nais.outbox")
SessionFactory = Callable[[], Session]


@dataclass(frozen=True)
class RelayResult:
    dispatched: int = 0
    retried: int = 0
    dead: int = 0


def backoff_seconds(attempts: int) -> float:
    return float(min(2**attempts, 300))


def _run_handlers(session_factory: SessionFactory, registry: HandlerRegistry, envelope: EventEnvelope) -> str | None:
    failures: list[str] = []
    for subscription in registry.handlers_for(envelope.event_type):
        try:
            with use_correlation_id(envelope.correlation_id), session_factory() as session, session.begin():
                subscription.handler(session, envelope)
        except Exception as exc:
            logger.exception(
                "event handler failed", extra={"handler": subscription.name, "event_id": str(envelope.event_id)}
            )
            failures.append(f"{subscription.name}: {exc!r}")
    return "; ".join(failures) or None


def dispatch_batch(
    session_factory: SessionFactory,
    registry: HandlerRegistry,
    *,
    batch_size: int = 100,
    max_attempts: int = 10,
    now: Callable[[], datetime] = clock.now,
) -> RelayResult:
    dispatched = retried = dead = 0
    with session_factory() as session, session.begin():
        rows = session.execute(
            select(outbox_events.c.id, outbox_events.c.envelope, outbox_events.c.attempts)
            .where(
                outbox_events.c.dispatched_at.is_(None),
                outbox_events.c.dead_at.is_(None),
                outbox_events.c.next_attempt_at <= now(),
            )
            .order_by(outbox_events.c.id)
            .limit(batch_size)
            .with_for_update(skip_locked=True)
        ).all()
        for row in rows:
            envelope = EventEnvelope.model_validate(row.envelope)
            error = _run_handlers(session_factory, registry, envelope)
            current = now()
            values: dict[str, Any]
            if error is None:
                values = {"dispatched_at": current, "last_error": None}
                dispatched += 1
            else:
                attempts = row.attempts + 1
                values = {"attempts": attempts, "last_error": error[:4000]}
                if attempts >= max_attempts:
                    values["dead_at"] = current
                    dead += 1
                else:
                    values["next_attempt_at"] = current + timedelta(seconds=backoff_seconds(attempts))
                    retried += 1
            session.execute(update(outbox_events).where(outbox_events.c.id == row.id).values(**values))
    return RelayResult(dispatched=dispatched, retried=retried, dead=dead)


def run_forever(
    stop: threading.Event,
    session_factory: SessionFactory,
    registry: HandlerRegistry,
    *,
    idle_sleep_s: float = 0.5,
    batch_size: int = 100,
    max_attempts: int = 10,
) -> None:
    while not stop.is_set():
        try:
            result = dispatch_batch(session_factory, registry, batch_size=batch_size, max_attempts=max_attempts)
        except Exception:
            logger.exception("outbox relay batch failed")
            stop.wait(idle_sleep_s * 4)
            continue
        if result == RelayResult():
            stop.wait(idle_sleep_s)
