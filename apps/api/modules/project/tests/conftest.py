from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from api.modules.project import MODULE
from api.modules.project.identity import IdentityQueryPort
from api.modules.project.identity_fake import FakeIdentityQueryPort
from api.modules.project.tests.helpers import ISSUER, ProjectApi, SeedPrincipalResolver
from api.platform import ports
from api.platform.auth import PrincipalResolver, TokenVerifier, get_token_verifier
from api.platform.migrate import upgrade_all
from api.platform.settings import Settings
from api.platform.testing.app import create_test_app
from api.platform.testing.fixtures import PgUrls


@pytest.fixture(scope="session")
def project_db(migrated_db: PgUrls) -> PgUrls:
    """Platform + project migrations applied once per test session."""
    upgrade_all(migrated_db.migrator, [MODULE])
    return migrated_db


@pytest.fixture
def db(project_db: PgUrls) -> Iterator[PgUrls]:
    """Empty project tables and outbox for every test."""
    engine = create_engine(project_db.migrator)
    with engine.begin() as conn:
        conn.execute(
            text("TRUNCATE project.project_members, project.project_organizations, project.projects")
        )
        conn.execute(text("DELETE FROM platform.outbox_events"))
    engine.dispose()
    yield project_db


@pytest.fixture
def identity() -> FakeIdentityQueryPort:
    fake = FakeIdentityQueryPort.with_seed_users()
    ports.provide(IdentityQueryPort, fake)
    return fake


@pytest.fixture
def app(db: PgUrls, identity: FakeIdentityQueryPort) -> FastAPI:
    application = create_test_app(modules=[MODULE], settings=Settings(database_url=db.app))
    application.dependency_overrides[get_token_verifier] = lambda: TokenVerifier(
        issuer=ISSUER.issuer, audience=ISSUER.audience, jwk_client=ISSUER.jwk_client()
    )
    ports.provide(PrincipalResolver, SeedPrincipalResolver())
    return application


@pytest.fixture
def api(app: FastAPI) -> ProjectApi:
    return ProjectApi(TestClient(app, raise_server_exceptions=False))
