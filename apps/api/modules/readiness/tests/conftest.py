"""Readiness test fixtures.

The actor binds to the global Dramatiq broker when api.modules.readiness is imported (D-036). pytest's
importlib mode imports this package (as apps.api.modules.readiness) BEFORE running this conftest, so the
actor may already be bound to whatever broker was global then: bind it to our StubBroker explicitly.
"""

from collections.abc import Iterator
from typing import Any
from uuid import UUID

import pytest
from dramatiq.brokers.stub import StubBroker
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from api.modules.readiness import MODULE, jobs
from api.modules.readiness.catalog_port import CatalogQueryPort, CatalogReadPort
from api.modules.readiness.fakes import FixtureCatalog
from api.modules.readiness.tests.helpers import USERS
from api.platform import ports
from api.platform.auth import CurrentUser, PrincipalResolver, TokenVerifier, get_token_verifier
from api.platform.broker import configure_broker
from api.platform.migrate import upgrade_all
from api.platform.settings import Settings
from api.platform.testing.app import create_test_app
from api.platform.testing.fixtures import PgUrls
from api.platform.testing.tokens import FakeIssuer

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


class FakePrincipals:
    """PrincipalResolver stand-in for M01: token `sub` is a key of helpers.USERS."""

    def resolve(self, claims: dict[str, Any], correlation_id: UUID) -> CurrentUser:
        return USERS[claims["sub"]]


@pytest.fixture
def client(db: PgUrls, catalog: FixtureCatalog) -> TestClient:
    issuer = FakeIssuer()
    app = create_test_app(modules=[MODULE], settings=Settings(database_url=db.app), broker=STUB_BROKER)
    app.dependency_overrides[get_token_verifier] = lambda: TokenVerifier(
        issuer=issuer.issuer, audience=issuer.audience, jwk_client=issuer.jwk_client()
    )
    ports.provide(PrincipalResolver, FakePrincipals())
    test_client = TestClient(app, raise_server_exceptions=False)
    test_client.issuer = issuer  # type: ignore[attr-defined]
    return test_client
