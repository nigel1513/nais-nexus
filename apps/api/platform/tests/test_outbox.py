import uuid

import pytest
from sqlalchemy import select

from api.platform.context import use_correlation_id
from api.platform.db import session_factory
from api.platform.events import EventActor, EventSchemaError
from api.platform.generated.event_types import EventType
from api.platform.outbox import OutboxWriter, outbox_events
from api.platform.testing.fixtures import PgUrls


def test_write_stores_a_schema_valid_envelope(migrated_db: PgUrls) -> None:
    project_id = uuid.uuid4()
    correlation = uuid.UUID("0192f0c0-0000-7000-8000-0000000000ef")
    with use_correlation_id(correlation), session_factory(migrated_db.app)() as session, session.begin():
        event_id = OutboxWriter().write(
            session, EventType.PROJECT_ARCHIVED_V1, {"project_id": str(project_id)}, EventActor.system()
        )
    with session_factory(migrated_db.app)() as session:
        row = session.execute(select(outbox_events).where(outbox_events.c.event_id == event_id)).one()
    assert row.event_type == "project.archived.v1"
    assert row.envelope["producer"] == "project"
    assert row.envelope["correlation_id"] == str(correlation)
    assert row.envelope["actor"] == {"type": "SYSTEM", "user_id": None, "organization_id": None}
    assert row.attempts == 0 and row.dispatched_at is None


def test_invalid_payload_is_rejected_before_insert(migrated_db: PgUrls) -> None:
    with pytest.raises(EventSchemaError, match="project_id"), session_factory(migrated_db.app)() as session:
        OutboxWriter().write(session, EventType.PROJECT_ARCHIVED_V1, {}, EventActor.system())


def test_unknown_event_type_is_rejected(migrated_db: PgUrls) -> None:
    with pytest.raises(ValueError), session_factory(migrated_db.app)() as session:
        OutboxWriter().write(session, "project.exploded.v1", {}, EventActor.system())


def test_rolled_back_transaction_leaves_no_event(migrated_db: PgUrls) -> None:
    with session_factory(migrated_db.app)() as session:
        with pytest.raises(RuntimeError), session.begin():
            event_id = OutboxWriter().write(
                session, EventType.PROJECT_ARCHIVED_V1, {"project_id": str(uuid.uuid4())}, EventActor.system()
            )
            raise RuntimeError("business failure after publish")
        assert session.execute(select(outbox_events).where(outbox_events.c.event_id == event_id)).first() is None
