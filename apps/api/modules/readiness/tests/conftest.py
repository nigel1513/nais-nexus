"""Readiness test fixtures.

The actor binds to the global Dramatiq broker when api.modules.readiness is imported (D-036). pytest's
importlib mode imports this package (as apps.api.modules.readiness) BEFORE running this conftest, so the
actor may already be bound to whatever broker was global then: bind it to our StubBroker explicitly.
"""

from collections.abc import Iterator

import pytest
from dramatiq.brokers.stub import StubBroker
from sqlalchemy import create_engine, text

from api.modules.readiness import MODULE, jobs
from api.modules.readiness.catalog_port import CatalogQueryPort, CatalogReadPort
from api.modules.readiness.fakes import FixtureCatalog
from api.platform import ports
from api.platform.broker import configure_broker
from api.platform.migrate import upgrade_all
from api.platform.settings import Settings
from api.platform.testing.fixtures import PgUrls

STUB_BROKER = configure_broker(Settings(), StubBroker())
if jobs.run_validation_actor.broker is not STUB_BROKER:
    jobs.run_validation_actor.broker = STUB_BROKER
    STUB_BROKER.declare_actor(jobs.run_validation_actor)


@pytest.fixture(scope="session")
def readiness_db(migrated_db: PgUrls) -> PgUrls:
    upgrade_all(migrated_db.migrator, [MODULE])
    return migrated_db


@pytest.fixture
def db(readiness_db: PgUrls) -> Iterator[PgUrls]:
    """Empty readiness tables + outbox + broker per test; the job and the public port use this database."""
    engine = create_engine(readiness_db.migrator)
    with engine.begin() as conn:
        conn.execute(
            text(
                "TRUNCATE readiness.check_results, readiness.validations, readiness.processed_events, "
                "platform.outbox_events"
            )
        )
    engine.dispose()
    STUB_BROKER.flush_all()
    previous = jobs.RUNTIME.database_url
    jobs.RUNTIME.database_url = readiness_db.app
    try:
        yield readiness_db
    finally:
        jobs.RUNTIME.database_url = previous


@pytest.fixture
def catalog() -> FixtureCatalog:
    fake = FixtureCatalog()
    ports.provide(CatalogQueryPort, fake)
    ports.provide(CatalogReadPort, fake)
    return fake
