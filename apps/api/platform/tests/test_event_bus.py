import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, text

from api.platform.db import session_factory
from api.platform.event_bus import HandlerRegistry, claim_event
from api.platform.events import EventActor, EventEnvelope
from api.platform.migration_helpers import create_processed_events
from api.platform.testing.fixtures import PgUrls


def envelope() -> EventEnvelope:
    return EventEnvelope(
        event_id=uuid.uuid4(),
        event_type="project.archived.v1",
        occurred_at=datetime.now(UTC),
        producer="project",
        correlation_id=uuid.uuid4(),
        actor=EventActor.system(),
        payload={"project_id": str(uuid.uuid4())},
    )


def test_subscribe_registers_handlers_in_order() -> None:
    registry = HandlerRegistry()

    @registry.subscribe("project.archived.v1")
    def first(session, event) -> None: ...  # type: ignore[no-untyped-def]

    @registry.subscribe("project.archived.v1")
    def second(session, event) -> None: ...  # type: ignore[no-untyped-def]

    names = [s.name for s in registry.handlers_for("project.archived.v1")]
    assert names == [
        f"{__name__}.test_subscribe_registers_handlers_in_order.<locals>.{n}" for n in ("first", "second")
    ]
    assert registry.handlers_for("project.created.v1") == []


def test_subscribe_rejects_unknown_event_types() -> None:
    with pytest.raises(ValueError):
        HandlerRegistry().subscribe("nope.v1")


@contextmanager
def processed_events_table(urls: PgUrls, *, per_handler: bool) -> Iterator[None]:
    engine = create_engine(urls.migrator)
    with engine.begin() as conn, Operations.context(MigrationContext.configure(conn)):
        create_processed_events("autonomy", per_handler=per_handler)
    try:
        yield
    finally:
        with engine.begin() as conn:
            conn.execute(text("DROP TABLE autonomy.processed_events"))
        engine.dispose()


def test_claim_event_is_idempotent(migrated_db: PgUrls) -> None:
    with processed_events_table(migrated_db, per_handler=False):
        event = envelope()
        with session_factory(migrated_db.app)() as session, session.begin():
            assert claim_event(session, "autonomy", event) is True
        with session_factory(migrated_db.app)() as session, session.begin():
            assert claim_event(session, "autonomy", event) is False


def test_claim_event_per_handler_claims_once_per_handler(migrated_db: PgUrls) -> None:
    with processed_events_table(migrated_db, per_handler=True):
        event = envelope()
        with session_factory(migrated_db.app)() as session, session.begin():
            assert claim_event(session, "autonomy", event, handler="grants") is True
            assert claim_event(session, "autonomy", event, handler="grants") is False
            assert claim_event(session, "autonomy", event, handler="notify") is True
        with session_factory(migrated_db.app)() as session:
            stored = session.execute(
                text("SELECT handler FROM autonomy.processed_events WHERE event_id = :id ORDER BY handler"),
                {"id": event.event_id},
            ).scalars()
            assert list(stored) == ["grants", "notify"]


def test_claim_event_rejects_unsafe_schema_names(migrated_db: PgUrls) -> None:
    with pytest.raises(ValueError), session_factory(migrated_db.app)() as session:
        claim_event(session, 'audit"; DROP TABLE x; --', envelope())
