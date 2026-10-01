from typing import Any

import pytest
from fastapi.testclient import TestClient

from api.modules.identity.seed_data import ORGS_BY_CODE
from api.modules.identity.tests.support import bearer, make_client, token_for
from api.platform.pagination import encode_cursor
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls

ACTIVE_NAMES = ["A Admin", "A Researcher", "A Steward", "B Admin", "B Researcher", "B Steward", "NAIS Admin"]


@pytest.fixture
def client(seeded: PgUrls) -> TestClient:
    return make_client(seeded)


def get(client: TestClient, path: str, **params: Any) -> Any:
    return client.get(path, params=params, headers=bearer(token_for("a.researcher@inst-a.local")))


def names(body: dict[str, Any]) -> list[str]:
    return [item["display_name"] for item in body["items"]]


def test_list_organizations_by_name(client: TestClient) -> None:
    response = get(client, "/api/v1/organizations")
    assert response.status_code == 200
    body = response.json()
    assert_matches_response("listOrganizations", 200, body)
    assert [org["code"] for org in body["items"]] == ["inst-a", "inst-b", "nais"]
    assert body["page"] == {"next_cursor": None, "has_more": False}


def test_list_organizations_pages(client: TestClient) -> None:
    first = get(client, "/api/v1/organizations", limit=2).json()
    assert [org["name"] for org in first["items"]] == ["Institute A", "Institute B"]
    assert first["page"]["has_more"] is True
    second = get(client, "/api/v1/organizations", limit=2, cursor=first["page"]["next_cursor"]).json()
    assert [org["name"] for org in second["items"]] == ["NAIS"]
    assert second["page"]["has_more"] is False


def test_organizations_require_authentication(client: TestClient) -> None:
    response = client.get("/api/v1/organizations")
    assert response.status_code == 401
    assert_matches_response("listOrganizations", 401, response.json())


def test_get_organization_counts_active_members(client: TestClient) -> None:
    inst_b = ORGS_BY_CODE["inst-b"].organization_id
    response = get(client, f"/api/v1/organizations/{inst_b}")
    assert response.status_code == 200
    body = response.json()
    assert_matches_response("getOrganization", 200, body)
    assert body["code"] == "inst-b" and body["type"] == "RESEARCH_INSTITUTE"
    assert body["member_count"] == 3  # b.disabled excluded
    assert "dataset_count" not in body
    assert body["ror_id"] is None and body["homepage_url"] is None


def test_get_unknown_organization_is_404(client: TestClient) -> None:
    response = get(client, "/api/v1/organizations/00000000-0000-7000-8000-00000000ffff")
    assert response.status_code == 404
    assert_matches_response("getOrganization", 404, response.json())


def test_user_search_by_email_prefix(client: TestClient) -> None:  # M01-AT-14
    response = get(client, "/api/v1/users", q="b.")
    assert response.status_code == 200
    body = response.json()
    assert_matches_response("listUsers", 200, body)
    assert names(body) == ["B Admin", "B Researcher", "B Steward"]  # b.disabled excluded
    for item in body["items"]:
        assert "email" not in item
        assert item["status"] == "ACTIVE"
        assert item["organization_name"] == "Institute B"


def test_user_search_by_display_name_fragment(client: TestClient) -> None:
    assert names(get(client, "/api/v1/users", q="esearch").json()) == ["A Researcher", "B Researcher"]


def test_user_search_by_organization(client: TestClient) -> None:
    inst_a = ORGS_BY_CODE["inst-a"].organization_id
    assert names(get(client, "/api/v1/users", organization_id=str(inst_a)).json()) == [
        "A Admin",
        "A Researcher",
        "A Steward",
    ]


def test_one_character_query_is_rejected(client: TestClient) -> None:
    response = get(client, "/api/v1/users", q="b")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"
    assert_matches_response("listUsers", 422, response.json())


def test_padded_short_query_is_rejected(client: TestClient) -> None:
    response = get(client, "/api/v1/users", q="  a ")
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"][0]["field"] == "q"


@pytest.mark.parametrize("q", ["%%", "__", "a%", "%@"])
def test_like_wildcards_are_literal(client: TestClient, q: str) -> None:
    response = get(client, "/api/v1/users", q=q)
    assert response.status_code == 200
    assert response.json()["items"] == []


def test_user_directory_pages_without_gaps(client: TestClient) -> None:
    seen: list[str] = []
    cursor = None
    while True:
        params: dict[str, Any] = {"limit": 3}
        if cursor:
            params["cursor"] = cursor
        body = get(client, "/api/v1/users", **params).json()
        seen += names(body)
        cursor = body["page"]["next_cursor"]
        if not body["page"]["has_more"]:
            break
    assert seen == ACTIVE_NAMES


@pytest.mark.parametrize("cursor", ["!!!not-base64", encode_cursor([1]), encode_cursor(["A", "not-a-uuid"])])
def test_bad_cursor_is_422(client: TestClient, cursor: str) -> None:
    for path in ("/api/v1/users", "/api/v1/organizations"):
        response = get(client, path, cursor=cursor)
        assert response.status_code == 422, path
        error = response.json()["error"]
        assert error["code"] == "VALIDATION_FAILED"
        assert error["details"]["fields"][0]["field"] == "cursor"


def test_user_search_with_nul_character_is_422(client: TestClient) -> None:
    response = get(client, "/api/v1/users", q="ab\x00c")
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "VALIDATION_FAILED"
    assert error["details"]["fields"] == [{"field": "(request)", "reason": "INVALID_CHARACTER"}]
    assert_matches_response("listUsers", 422, response.json())
