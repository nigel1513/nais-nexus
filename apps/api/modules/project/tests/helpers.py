"""Test helpers for the project module: fake auth mapped to seed users, API wrapper, DB/outbox readers."""

from typing import Any
from uuid import UUID

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from api.modules.project import repository as repo
from api.modules.project.seed_data import USERS_BY_KEY
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.db import session_scope
from api.platform.testing.contracts import assert_matches_response, assert_valid_event
from api.platform.testing.fixtures import PgUrls
from api.platform.testing.tokens import FakeIssuer

ISSUER = FakeIssuer()


def current_user_for(key: str, session_id: str = "session-1") -> CurrentUser:
    user = USERS_BY_KEY[key]
    return CurrentUser(
        user_id=user.user_id,
        organization_id=user.organization_id,
        org_roles=user.org_roles,
        platform_roles=user.platform_roles,
        session_id=session_id,
        display_name=user.display_name,
    )


class SeedPrincipalResolver:
    """Stands in for M01's PrincipalResolver: the token `sub` is a seed user key such as "a.researcher"."""

    def resolve(self, claims: dict[str, Any], correlation_id: UUID) -> CurrentUser:
        return current_user_for(claims["sub"], claims["sid"])


def uid(key: str) -> str:
    return str(USERS_BY_KEY[key].user_id)


class ProjectApi:
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

    def create_project(self, user: str = "a.researcher", **fields: Any) -> dict[str, Any]:
        body = {"name": "Joint Battery Study", "description": "Cross-institute work."} | fields
        response = self.post(user, "/projects", json=body)
        assert response.status_code == 201, response.text
        result: dict[str, Any] = response.json()
        return result


def sql(urls: PgUrls, statement: str, **params: Any) -> list[dict[str, Any]]:
    """Run SQL as the schema owner (bypasses the API) and return rows as dicts."""
    engine = create_engine(urls.migrator)
    try:
        with engine.begin() as conn:
            result = conn.execute(text(statement), params)
            return [dict(row) for row in result.mappings()] if result.returns_rows else []
    finally:
        engine.dispose()


def project_events(urls: PgUrls) -> list[dict[str, Any]]:
    rows = sql(
        urls,
        "SELECT envelope FROM platform.outbox_events WHERE envelope->>'producer' = 'project' ORDER BY id",
    )
    envelopes = [row["envelope"] for row in rows]
    for envelope in envelopes:
        assert_valid_event(envelope)
    return envelopes


def assert_error(response: httpx.Response, status: int, code: str, operation_id: str) -> None:
    """Every error status the module returns is declared in openapi.yaml 1.2.0 (M00 kickoff, W1-D3)."""
    assert response.status_code == status, response.text
    body = response.json()
    assert body["error"]["code"] == code, body
    assert_matches_response(operation_id, status, body)


def seed_member(urls: PgUrls, project_id: str, key: str, role: str) -> None:
    """Insert an ACTIVE member directly (no API rules, no event) to set up a scenario."""
    user = USERS_BY_KEY[key]
    with session_scope(urls.app) as session:
        repo.insert_member(
            session,
            project_id=UUID(project_id),
            user_id=user.user_id,
            organization_id=user.organization_id,
            role=role,
            added_by=user.user_id,
            now=clock.now(),
        )
        repo.add_org_member(session, UUID(project_id), user.organization_id)
