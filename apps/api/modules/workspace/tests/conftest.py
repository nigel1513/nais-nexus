from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from api.modules.catalog.public import CatalogQueryPort
from api.modules.project.public import ProjectQueryPort
from api.modules.workspace import MODULE
from api.modules.workspace.deps import WorkspaceDeps
from api.modules.workspace.settings import WorkspaceSettings
from api.modules.workspace.tests.fakes import USERS, FakeCatalog, FakeGrants, FakePeople, FakeProjects
from api.modules.workspace.wiring import install
from api.platform import ports
from api.platform.auth import CurrentUser, PrincipalResolver, TokenVerifier, get_token_verifier
from api.platform.migrate import upgrade_all
from api.platform.settings import Settings
from api.platform.testing.app import create_test_app
from api.platform.testing.fixtures import PgUrls
from api.platform.testing.tokens import FakeIssuer

ISSUER = FakeIssuer()


@pytest.fixture(scope="session")
def workspace_db(migrated_db: PgUrls) -> PgUrls:
    """Platform + workspace migrations applied once per test session."""
    upgrade_all(migrated_db.migrator, [MODULE])
    return migrated_db


@pytest.fixture
def db(workspace_db: PgUrls) -> Iterator[PgUrls]:
    """Empty workspace tables and outbox for every test."""
    engine = create_engine(workspace_db.migrator)
    with engine.begin() as conn:
        conn.execute(
            text(
                "TRUNCATE workspace.inputs, workspace.processed_events, workspace.threads, workspace.comments,"
                " workspace.dataset_activity, workspace.hub_access_requests"
            )
        )
        conn.execute(text("DELETE FROM platform.outbox_events"))
    engine.dispose()
    yield workspace_db


class FakePrincipals:
    """PrincipalResolver stand-in for M01: the token `sub` is a key of fakes.USERS."""

    def resolve(self, claims: dict[str, Any], correlation_id: UUID) -> CurrentUser:
        return USERS[claims["sub"]]


@dataclass
class World:
    projects: FakeProjects
    catalog: FakeCatalog
    grants: FakeGrants
    people: FakePeople


@pytest.fixture
def world() -> World:
    w = World(FakeProjects(), FakeCatalog(), FakeGrants(), FakePeople())
    ports.provide(ProjectQueryPort, w.projects)
    ports.provide(CatalogQueryPort, w.catalog)
    return w


class WorkspaceApi:
    def __init__(self, client: TestClient) -> None:
        self.client = client

    def request(self, method: str, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        headers = {"Authorization": f"Bearer {ISSUER.token(sub=user)}"} if user else {}
        return self.client.request(method, f"/api/v1{path}", headers=headers, **kwargs)

    def get(self, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        return self.request("GET", user, path, **kwargs)

    def post(self, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        return self.request("POST", user, path, **kwargs)

    def patch(self, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        return self.request("PATCH", user, path, **kwargs)

    def delete(self, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        return self.request("DELETE", user, path, **kwargs)


@pytest.fixture
def api(db: PgUrls, world: World) -> WorkspaceApi:
    app = create_test_app(modules=[MODULE], settings=Settings(database_url=db.app))
    # replace the wired defaults (NoGrants, identity adapter) with the test doubles
    install(WorkspaceDeps(settings=WorkspaceSettings(), grants=world.grants, people=world.people))
    app.dependency_overrides[get_token_verifier] = lambda: TokenVerifier(
        issuer=ISSUER.issuer, audience=ISSUER.audience, jwk_client=ISSUER.jwk_client()
    )
    ports.provide(PrincipalResolver, FakePrincipals())
    return WorkspaceApi(TestClient(app, raise_server_exceptions=False))


def sql(urls: PgUrls, statement: str, **params: Any) -> list[dict[str, Any]]:
    """Run SQL as the schema owner (bypasses the API) and return rows as dicts."""
    engine = create_engine(urls.migrator)
    try:
        with engine.begin() as conn:
            result = conn.execute(text(statement), params)
            return [dict(row) for row in result.mappings()] if result.returns_rows else []
    finally:
        engine.dispose()


def outbox(urls: PgUrls) -> list[dict[str, Any]]:
    """Envelopes the workspace wrote to the outbox, oldest first."""
    rows = sql(
        urls,
        "SELECT envelope FROM platform.outbox_events WHERE envelope->>'producer' = 'workspace' ORDER BY id",
    )
    return [row["envelope"] for row in rows]
