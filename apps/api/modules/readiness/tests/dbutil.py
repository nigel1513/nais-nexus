"""DB / broker helpers for readiness tests that use the `db` fixture."""

import json
import uuid
from typing import Any

from dramatiq import Worker
from dramatiq.brokers.stub import StubBroker
from sqlalchemy import select

from api.modules.readiness import jobs
from api.modules.readiness.tables import validations
from api.platform.db import session_factory
from api.platform.outbox import outbox_events
from api.platform.testing.contracts import assert_valid_event
from api.platform.testing.fixtures import PgUrls

CORRELATION = uuid.UUID("0199a000-0000-7000-8000-00000000c0de")


def row(db: PgUrls, validation_id: uuid.UUID) -> dict[str, Any]:
    with session_factory(db.app)() as session:
        query = select(validations).where(validations.c.validation_id == validation_id)
        return dict(session.execute(query).mappings().one())


def events(db: PgUrls) -> list[dict[str, Any]]:
    """Every outbox envelope in insert order, each checked against p0_events.schema.json."""
    with session_factory(db.app)() as session:
        envelopes = list(
            session.execute(select(outbox_events.c.envelope).order_by(outbox_events.c.id)).scalars()
        )
    for envelope in envelopes:
        assert_valid_event(envelope)
    return envelopes


def queued_messages() -> list[dict[str, Any]]:
    broker = jobs.run_validation_actor.broker
    assert isinstance(broker, StubBroker)
    return [json.loads(m) for m in list(broker.queues[jobs.QUEUE].queue)]


def drain_jobs() -> None:
    """Process every queued readiness message with a real Dramatiq worker on the actor's (stub) broker."""
    broker = jobs.run_validation_actor.broker
    worker = Worker(broker, worker_timeout=50, worker_threads=2)
    worker.start()
    try:
        broker.join(jobs.QUEUE, fail_fast=True)
        worker.join()
    finally:
        worker.stop()
