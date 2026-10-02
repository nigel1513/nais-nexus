"""API client for catalog tests: FakeIssuer tokens resolved to seed users by FakePrincipalResolver."""

from dataclasses import dataclass
from typing import Any
from uuid import UUID

import httpx
from fastapi.testclient import TestClient

from api.modules.catalog import MODULE
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.tests.support import ORG_A, ORG_B, ORG_NAIS, seed_user_id
from api.modules.catalog.wiring import install
from api.platform import ports
from api.platform.auth import CurrentUser, PrincipalResolver, TokenVerifier, get_token_verifier
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.settings import Settings
from api.platform.testing.app import create_test_app
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls
from api.platform.testing.tokens import FakeIssuer


def _user(suffix: str, org: UUID, roles: tuple[str, ...] = (), platform: tuple[str, ...] = ()) -> CurrentUser:
    return CurrentUser(
        user_id=seed_user_id(suffix),
        organization_id=org,
        org_roles=frozenset(roles),
        platform_roles=frozenset(platform),
        session_id=f"session-{suffix}",
        display_name=suffix,
    )


USERS: dict[str, CurrentUser] = {
    "platform.admin": _user("0101", ORG_NAIS, ("ORG_ADMIN",), ("PLATFORM_ADMIN",)),
    "a.admin": _user("0a01", ORG_A, ("ORG_ADMIN",)),
    "a.researcher": _user("0a02", ORG_A),
    "a.steward": _user("0a03", ORG_A, ("DATA_STEWARD",)),
    "b.admin": _user("0b01", ORG_B, ("ORG_ADMIN",)),
    "b.researcher": _user("0b02", ORG_B),
    "b.steward": _user("0b03", ORG_B, ("DATA_STEWARD",)),
}


class FakePrincipalResolver:
    def resolve(self, claims: dict[str, Any], correlation_id: UUID) -> CurrentUser:
        user = USERS.get(str(claims.get("sub")))
        if user is None:
            raise ApiError(ErrorCode.UNAUTHENTICATED)
        return user


@dataclass
class CatalogApi:
    client: TestClient
    issuer: FakeIssuer
    deps: CatalogDeps

    def use(self, deps: CatalogDeps) -> None:
        self.deps = deps
        install(deps)

    def request(self, method: str, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        headers = dict(kwargs.pop("headers", None) or {})
        if user is not None:
            headers["Authorization"] = f"Bearer {self.issuer.token(sub=user)}"
        return self.client.request(method, f"/api/v1{path}", headers=headers, **kwargs)

    def get(self, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        return self.request("GET", user, path, **kwargs)

    def post(self, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        return self.request("POST", user, path, **kwargs)

    def patch(self, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        return self.request("PATCH", user, path, **kwargs)

    def delete(self, user: str | None, path: str, **kwargs: Any) -> httpx.Response:
        return self.request("DELETE", user, path, **kwargs)


def make_api(urls: PgUrls, deps: CatalogDeps) -> CatalogApi:
    issuer = FakeIssuer()
    app = create_test_app(modules=[MODULE], settings=Settings(database_url=urls.app))
    verifier = TokenVerifier(issuer=issuer.issuer, audience=issuer.audience, jwk_client=issuer.jwk_client())
    app.dependency_overrides[get_token_verifier] = lambda: verifier
    ports.provide(PrincipalResolver, FakePrincipalResolver())
    install(deps)
    return CatalogApi(TestClient(app, raise_server_exceptions=False), issuer, deps)


def assert_error(operation_id: str, response: httpx.Response, status: int, code: str) -> dict[str, Any]:
    """Status + error code + contract check (openapi 1.2.0 declares every error status the catalog returns)."""
    assert response.status_code == status, response.text
    body = response.json()
    assert_matches_response(operation_id, status, body)
    assert set(body) == {"error"}, body
    assert body["error"]["code"] == code, body
    assert body["error"]["trace_id"]
    error: dict[str, Any] = body["error"]
    return error


def dataset_body(owner: UUID = ORG_B, **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "owner_organization_id": str(owner),
        "title": "Battery Cycling Measurements",
        "description": "Charge/discharge cycling of pouch cells.",
        "keywords": ["battery", "cycling"],
        "domain": "materials",
        "access_level": "CONTROLLED",
        "license": "CC-BY-4.0",
        "allowed_purposes": ["ACADEMIC_RESEARCH", "AI_TRAINING"],
        "principal_investigator_id": str(seed_user_id("0b02" if owner == ORG_B else "0a02")),
        "data_steward_contact_id": str(seed_user_id("0b03" if owner == ORG_B else "0a03")),
    }
    body.update(overrides)
    return body


def create_dataset(api: CatalogApi, user: str = "b.steward", **overrides: Any) -> dict[str, Any]:
    owner = ORG_A if user.startswith("a.") else ORG_B
    response = api.post(user, "/datasets", json=dataset_body(owner, **overrides))
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()
    return created


def new_draft(api: CatalogApi, user: str = "b.steward", **dataset_overrides: Any) -> tuple[str, str]:
    dataset_id = create_dataset(api, user, **dataset_overrides)["dataset_id"]
    response = api.post(user, f"/datasets/{dataset_id}/versions", json={"version_label": "v1"})
    assert response.status_code == 201, response.text
    return dataset_id, response.json()["dataset_version_id"]
