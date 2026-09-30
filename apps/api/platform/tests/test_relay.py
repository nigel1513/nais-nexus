import threading
import time
import uuid
from collections import Counter
from datetime import timedelta

from sqlalchemy import delete, select

from api.platform import clock
from api.platform.context import correlation_id
from api.platform.db import session_factory
from api.platform.event_bus import HandlerRegistry
from api.platform.events import EventActor, EventEnvelope
from api.platform.outbox import OutboxWriter, outbox_events
from api.platform.relay import dispatch_batch
from api.platform.testing.fixtures import PgUrls

EVENT = "project.archived.v1"


def clear_outbox(url: str) -> None:
    with session_factory(url)() as session, session.begin():
        session.execute(delete(outbox_events))


def publish(url: str, count: int = 1) -> list[uuid.UUID]:
    ids = []
    with session_factory(url)() as session, session.begin():
        for _ in range(count):
            ids.append(OutboxWriter().write(session, EVENT, {"project_id": str(uuid.uuid4())}, EventActor.system()))
    return ids


def row(url: str, event_id: uuid.UUID):  # type: ignore[no-untyped-def]
    with session_factory(url)() as session:
        return session.execute(select(outbox_events).where(outbox_events.c.event_id == event_id)).one()


def test_handler_receives_event_with_its_correlation_id(migrated_db: PgUrls) -> None:
    clear_outbox(migrated_db.app)
    seen: list[tuple[uuid.UUID, uuid.UUID]] = []
    registry = HandlerRegistry()

    @registry.subscribe(EVENT)
    def handler(session, event: EventEnvelope) -> None:  # type: ignore[no-untyped-def]
        seen.append((event.event_id, correlation_id()))

    [event_id] = publish(migrated_db.app)
    result = dispatch_batch(session_factory(migrated_db.app), registry)
    assert result.dispatched == 1
    envelope_correlation = uuid.UUID(row(migrated_db.app, event_id).envelope["correlation_id"])
    assert seen == [(event_id, envelope_correlation)]
    assert row(migrated_db.app, event_id).dispatched_at is not None


def test_events_without_handlers_are_marked_dispatched(migrated_db: PgUrls) -> None:
    clear_outbox(migrated_db.app)
    [event_id] = publish(migrated_db.app)
    assert dispatch_batch(session_factory(migrated_db.app), HandlerRegistry()).dispatched == 1
    assert row(migrated_db.app, event_id).dispatched_at is not None


def test_failing_handler_is_retried_with_backoff_then_dead(migrated_db: PgUrls) -> None:
    clear_outbox(migrated_db.app)
    registry = HandlerRegistry()

    @registry.subscribe(EVENT)
    def broken(session, event) -> None:  # type: ignore[no-untyped-def]
        raise RuntimeError("downstream exploded")

    [event_id] = publish(migrated_db.app)
    factory = session_factory(migrated_db.app)
    assert dispatch_batch(factory, registry, max_attempts=2).retried == 1
    first = row(migrated_db.app, event_id)
    assert first.attempts == 1 and "downstream exploded" in first.last_error
    assert dispatch_batch(factory, registry, max_attempts=2).retried == 0  # not due yet (backoff 2s)
    later = clock.now() + timedelta(seconds=10)
    assert dispatch_batch(factory, registry, max_attempts=2, now=lambda: later).dead == 1
    assert row(migrated_db.app, event_id).dead_at is not None


def test_other_handlers_still_run_when_one_fails(migrated_db: PgUrls) -> None:
    clear_outbox(migrated_db.app)
    calls: list[str] = []
    registry = HandlerRegistry()

    @registry.subscribe(EVENT)
    def ok(session, event) -> None:  # type: ignore[no-untyped-def]
        calls.append("ok")

    @registry.subscribe(EVENT)
    def broken(session, event) -> None:  # type: ignore[no-untyped-def]
        raise RuntimeError("nope")

    publish(migrated_db.app)
    dispatch_batch(session_factory(migrated_db.app), registry)
    assert calls == ["ok"]


def test_concurrent_relays_dispatch_each_event_once(migrated_db: PgUrls) -> None:
    clear_outbox(migrated_db.app)
    counts: Counter[uuid.UUID] = Counter()
    lock = threading.Lock()
    registry = HandlerRegistry()

    @registry.subscribe(EVENT)
    def slow(session, event: EventEnvelope) -> None:  # type: ignore[no-untyped-def]
        time.sleep(0.01)
        with lock:
            counts[event.event_id] += 1

    ids = publish(migrated_db.app, count=40)
    factory = session_factory(migrated_db.app)

    def drain() -> None:
        for _ in range(10):
            dispatch_batch(factory, registry, batch_size=5)

    threads = [threading.Thread(target=drain) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert set(counts) == set(ids)
    assert set(counts.values()) == {1}
