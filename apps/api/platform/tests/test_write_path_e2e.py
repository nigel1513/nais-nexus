"""E1: SessionDep write + outbox in one transaction -> relay -> per-handler claim, delivered twice, processed once."""

import uuid
from collections.abc import Iterator

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi import APIRouter
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, delete, text, update
from sqlalchemy.orm import Session

from api.platform.db import SessionDep, session_factory
from api.platform.event_bus import HandlerRegistry, claim_event
from api.platform.events import EventActor, EventEnvelope
from api.platform.migration_helpers import create_processed_events
from api.platform.modules import ModuleSpec
from api.platform.outbox import outbox, outbox_events
from api.platform.relay import dispatch_batch
from api.platform.settings import Settings
from api.platform.testing.app import create_test_app
from api.platform.testing.fixtures import PgUrls

EVENT = "project.archived.v1"


@pytest.fixture
def tables(migrated_db: PgUrls) -> Iterator[PgUrls]:
    engine = create_engine(migrated_db.migrator)
    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE autonomy.e2e_items (id uuid NOT NULL, "
                "CONSTRAINT e2e_items_id_key UNIQUE (id) DEFERRABLE INITIALLY DEFERRED)"
            )
        )
        with Operations.context(MigrationContext.configure(conn)):
            create_processed_events("autonomy", per_handler=True)
    with session_factory(migrated_db.app)() as session, session.begin():
        session.execute(delete(outbox_events))
    try:
        yield migrated_db
    finally:
        with engine.begin() as conn:
            conn.execute(text("DROP TABLE autonomy.e2e_items, autonomy.processed_events"))
        engine.dispose()


def client(urls: PgUrls) -> TestClient:
    router = APIRouter()

    @router.post("/items/{item_id}")
    def create_item(item_id: uuid.UUID, session: SessionDep, copies: int = 1) -> dict[str, str]:
        for _ in range(copies):
            session.execute(text("INSERT INTO autonomy.e2e_items (id) VALUES (:id)"), {"id": item_id})
        outbox.write(session, EVENT, {"project_id": str(item_id)}, EventActor.system())
        return {"id": str(item_id)}

    app = create_test_app(
        modules=[ModuleSpec(name="e2e", router=router)], settings=Settings(database_url=urls.app)
    )
    return TestClient(app, raise_server_exceptions=False)


def count(urls: PgUrls, sql: str) -> int:
    with session_factory(urls.app)() as session:
        return int(session.execute(text(sql)).scalar_one())


def test_write_outbox_relay_and_per_handler_claim(tables: PgUrls) -> None:
    item_id = uuid.uuid4()
    assert client(tables).post(f"/api/v1/items/{item_id}").status_code == 200
    assert count(tables, "SELECT count(*) FROM autonomy.e2e_items") == 1
    assert count(tables, "SELECT count(*) FROM platform.outbox_events") == 1

    registry = HandlerRegistry()
    effects: list[uuid.UUID] = []

    @registry.subscribe(EVENT)
    def probe(session: Session, event: EventEnvelope) -> None:
        if claim_event(session, "autonomy", event, handler="probe"):
            effects.append(event.event_id)

    factory = session_factory(tables.app)
    assert dispatch_batch(factory, registry).dispatched == 1
    with factory() as session, session.begin():  # at-least-once: simulate a redelivery
        session.execute(update(outbox_events).values(dispatched_at=None))
    assert dispatch_batch(factory, registry).dispatched == 1

    assert len(effects) == 1
    assert count(tables, "SELECT count(*) FROM autonomy.processed_events WHERE handler = 'probe'") == 1


def test_failed_commit_drops_both_the_row_and_the_event(tables: PgUrls) -> None:
    response = client(tables).post(f"/api/v1/items/{uuid.uuid4()}", params={"copies": 2})
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "INTERNAL_ERROR"
    assert count(tables, "SELECT count(*) FROM autonomy.e2e_items") == 0
    assert count(tables, "SELECT count(*) FROM platform.outbox_events") == 0
