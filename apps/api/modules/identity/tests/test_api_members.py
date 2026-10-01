from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from api.modules.identity.members import update_member
from api.modules.identity.schemas import MemberUpdateIn
from api.modules.identity.seed_data import ORGS_BY_CODE, USERS_BY_EMAIL
from api.modules.identity.tests.support import bearer, events, make_client, token_for
from api.platform.auth import CurrentUser
from api.platform.db import session_scope
from api.platform.errors import ApiError
from api.platform.testing.contracts import assert_matches_response, assert_valid_event
from api.platform.testing.fixtures import PgUrls

CHANGED = "identity.membership.changed.v1"
INST_A = ORGS_BY_CODE["inst-a"].organization_id
INST_B = ORGS_BY_CODE["inst-b"].organization_id


def uid(email: str) -> UUID:
    return USERS_BY_EMAIL[email].user_id


@pytest.fixture
def client(seeded: PgUrls) -> TestClient:
    return make_client(seeded)


def members(client: TestClient, as_email: str, org: UUID) -> Any:
    return client.get(f"/api/v1/organizations/{org}/members", headers=bearer(token_for(as_email)))


def patch(client: TestClient, as_email: str, org: UUID, target: str, body: dict[str, Any]) -> Any:
    return client.patch(
        f"/api/v1/organizations/{org}/members/{uid(target)}", json=body, headers=bearer(token_for(as_email))
    )


def error_code(response: Any) -> str:
    return str(response.json()["error"]["code"])


def test_member_without_admin_role_cannot_list(client: TestClient) -> None:  # M01-AT-10
    response = members(client, "a.researcher@inst-a.local", INST_A)
    assert response.status_code == 403 and error_code(response) == "FORBIDDEN"
    assert_matches_response("listOrganizationMembers", 403, response.json())


def test_org_admin_lists_own_members_with_email(client: TestClient) -> None:
    response = members(client, "a.admin@inst-a.local", INST_A)
    assert response.status_code == 200
    body = response.json()
    assert_matches_response("listOrganizationMembers", 200, body)
    assert [m["email"] for m in body["items"]] == [
        "a.admin@inst-a.local",
        "a.researcher@inst-a.local",
        "a.steward@inst-a.local",
    ]


def test_other_org_admin_cannot_list(client: TestClient) -> None:
    assert members(client, "b.admin@inst-b.local", INST_A).status_code == 403


def test_platform_admin_lists_disabled_members_too(client: TestClient) -> None:
    body = members(client, "admin@nais.local", INST_B).json()
    statuses = {m["email"]: m["status"] for m in body["items"]}
    assert statuses["b.disabled@inst-b.local"] == "DISABLED"
    assert len(statuses) == 4


def test_unknown_org_members_is_404(client: TestClient) -> None:
    response = members(client, "admin@nais.local", UUID("00000000-0000-7000-8000-00000000ffff"))
    assert response.status_code == 404 and error_code(response) == "NOT_FOUND"
    assert_matches_response("listOrganizationMembers", 404, response.json())


def test_admin_of_other_org_cannot_patch(client: TestClient) -> None:  # M01-AT-09
    response = patch(client, "a.admin@inst-a.local", INST_B, "b.researcher@inst-b.local", {"roles": []})
    assert response.status_code == 403 and error_code(response) == "FORBIDDEN"
    assert_matches_response("updateOrganizationMember", 403, response.json())


def test_org_admin_cannot_drop_own_admin_role(client: TestClient) -> None:  # M01-AT-11
    response = patch(client, "a.admin@inst-a.local", INST_A, "a.admin@inst-a.local", {"roles": []})
    assert response.status_code == 422 and error_code(response) == "ROLE_NOT_ASSIGNABLE"
    assert_matches_response("updateOrganizationMember", 422, response.json())


def test_org_admin_cannot_disable_self(client: TestClient) -> None:
    response = patch(client, "a.admin@inst-a.local", INST_A, "a.admin@inst-a.local", {"status": "DISABLED"})
    assert response.status_code == 422 and error_code(response) == "ROLE_NOT_ASSIGNABLE"


def test_platform_role_is_not_assignable(client: TestClient) -> None:  # M01-AT-12
    body = {"roles": ["PLATFORM_ADMIN"]}
    response = patch(client, "a.admin@inst-a.local", INST_A, "a.researcher@inst-a.local", body)
    assert response.status_code == 422 and error_code(response) == "ROLE_NOT_ASSIGNABLE"


@pytest.mark.parametrize(
    "body",
    [{}, {"roles": ["DATA_STEWARD", "DATA_STEWARD"]}, {"status": "GONE"}, {"roles": [], "extra": 1}],
)
def test_malformed_bodies_are_validation_failed(client: TestClient, body: dict[str, Any]) -> None:
    response = patch(client, "a.admin@inst-a.local", INST_A, "a.researcher@inst-a.local", body)
    assert response.status_code == 422 and error_code(response) == "VALIDATION_FAILED"


def test_member_of_another_org_is_404(client: TestClient) -> None:
    response = patch(client, "a.admin@inst-a.local", INST_A, "b.researcher@inst-b.local", {"roles": []})
    assert response.status_code == 404 and error_code(response) == "NOT_FOUND"
    assert_matches_response("updateOrganizationMember", 404, response.json())


def test_granting_a_role_is_visible_on_the_same_token(client: TestClient, seeded: PgUrls) -> None:
    # M01-AT-13, M01-AT-15
    researcher = bearer(token_for("a.researcher@inst-a.local", sid="researcher-session"))
    assert client.get("/api/v1/me", headers=researcher).json()["org_roles"] == []

    body = {"roles": ["DATA_STEWARD"]}
    response = patch(client, "a.admin@inst-a.local", INST_A, "a.researcher@inst-a.local", body)
    assert response.status_code == 200, response.text
    assert_matches_response("updateOrganizationMember", 200, response.json())
    assert response.json()["roles"] == ["DATA_STEWARD"]

    changed = events(seeded, CHANGED, user_id=str(uid("a.researcher@inst-a.local")))
    assert len(changed) == 1
    assert_valid_event(changed[0])
    assert changed[0]["payload"] == {
        "user_id": str(uid("a.researcher@inst-a.local")),
        "organization_id": str(INST_A),
        "previous_roles": [],
        "roles": ["DATA_STEWARD"],
        "previous_status": "ACTIVE",
        "status": "ACTIVE",
    }
    assert changed[0]["actor"] == {
        "type": "USER",
        "user_id": str(uid("a.admin@inst-a.local")),
        "organization_id": str(INST_A),
    }
    assert changed[0]["correlation_id"] == response.headers["x-request-id"]
    assert client.get("/api/v1/me", headers=researcher).json()["org_roles"] == ["DATA_STEWARD"]


def test_disabling_blocks_the_next_request(client: TestClient, seeded: PgUrls) -> None:  # M01-AT-06
    researcher = bearer(token_for("a.researcher@inst-a.local", sid="researcher-session"))
    assert client.get("/api/v1/me", headers=researcher).status_code == 200
    body = {"status": "DISABLED"}
    assert patch(client, "a.admin@inst-a.local", INST_A, "a.researcher@inst-a.local", body).status_code == 200
    blocked = client.get("/api/v1/me", headers=researcher)
    assert blocked.status_code == 403 and error_code(blocked) == "MEMBERSHIP_DISABLED"
    assert len(events(seeded, CHANGED, user_id=str(uid("a.researcher@inst-a.local")))) == 1

    body = {"status": "ACTIVE"}
    assert patch(client, "a.admin@inst-a.local", INST_A, "a.researcher@inst-a.local", body).status_code == 200
    assert client.get("/api/v1/me", headers=researcher).status_code == 200


def test_no_op_update_emits_nothing(client: TestClient, seeded: PgUrls) -> None:
    body = {"roles": ["DATA_STEWARD"], "status": "ACTIVE"}
    response = patch(client, "a.admin@inst-a.local", INST_A, "a.steward@inst-a.local", body)
    assert response.status_code == 200
    assert events(seeded, CHANGED) == []


def test_admin_may_remove_another_admin_when_not_last(client: TestClient) -> None:
    both = {"roles": ["DATA_STEWARD", "ORG_ADMIN"]}
    assert patch(client, "admin@nais.local", INST_A, "a.steward@inst-a.local", both).status_code == 200
    response = patch(
        client, "a.admin@inst-a.local", INST_A, "a.steward@inst-a.local", {"roles": ["DATA_STEWARD"]}
    )
    assert response.status_code == 200 and response.json()["roles"] == ["DATA_STEWARD"]


def test_platform_admin_may_remove_last_org_admin(client: TestClient) -> None:
    response = patch(client, "admin@nais.local", INST_A, "a.admin@inst-a.local", {"roles": []})
    assert response.status_code == 200 and response.json()["roles"] == []


def test_non_platform_admin_cannot_remove_last_org_admin(seeded: PgUrls) -> None:
    # A caller whose token still says ORG_ADMIN (e.g. resolved a moment before losing the role) removes the
    # organization's only ACTIVE ORG_ADMIN: the last-admin guard must hold even though self-rules do not apply.
    actor = CurrentUser(
        user_id=uid("a.steward@inst-a.local"),
        organization_id=INST_A,
        org_roles=frozenset({"ORG_ADMIN"}),
        session_id="s",
        display_name="A Steward",
    )
    with pytest.raises(ApiError) as caught, session_scope(seeded.app) as session:
        update_member(session, actor, INST_A, uid("a.admin@inst-a.local"), MemberUpdateIn(roles=[]))
    assert caught.value.code.value == "ROLE_NOT_ASSIGNABLE"
