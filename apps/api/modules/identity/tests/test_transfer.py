from typing import Any

import pytest

from api.modules.identity.keycloak_admin import FakeKeycloakAdmin, KeycloakAdminPort
from api.modules.identity.seed_data import ORGS_BY_CODE, USERS_BY_EMAIL
from api.modules.identity.tests.support import bearer, events, make_client, scalar, token_for
from api.platform import ports
from api.platform.testing.contracts import assert_matches_response, assert_valid_event
from api.platform.testing.fixtures import PgUrls

RESEARCHER = USERS_BY_EMAIL["a.researcher@inst-a.local"]
INST_B = ORGS_BY_CODE["inst-b"].organization_id
ADMIN = "admin@nais.local"


@pytest.fixture
def keycloak() -> FakeKeycloakAdmin:
    return FakeKeycloakAdmin()


def client_with(seeded: PgUrls, keycloak: FakeKeycloakAdmin) -> Any:
    client = make_client(seeded)
    ports.provide(KeycloakAdminPort, keycloak)
    return client


def test_platform_admin_transfers_researcher(seeded: PgUrls, keycloak: FakeKeycloakAdmin) -> None:
    client = client_with(seeded, keycloak)
    response = client.post(
        f"/api/v1/users/{RESEARCHER.user_id}/transfer",
        json={"organization_id": str(INST_B), "roles": ["DATA_STEWARD"]},
        headers=bearer(token_for(ADMIN)),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert_matches_response("transferUserOrganization", 200, body)
    assert (
        body["organization_id"] == str(INST_B)
        and body["roles"] == ["DATA_STEWARD"]
        and body["status"] == "ACTIVE"
    )
    assert keycloak.calls == [(RESEARCHER.user_id, "inst-b")]
    assert (
        scalar(
            seeded,
            "SELECT count(*) FROM identity.organization_memberships WHERE user_id = :u",
            u=RESEARCHER.user_id,
        )
        == 2
    )
    changed = events(seeded, "identity.membership.changed.v1")
    assert [(e["payload"]["previous_status"], e["payload"]["status"]) for e in changed] == [
        ("ACTIVE", "DISABLED"),
        ("DISABLED", "ACTIVE"),
    ]
    for event in changed:
        assert_valid_event(event)
    me = client.get("/api/v1/me", headers=bearer(token_for(RESEARCHER.email, org_code="inst-b"))).json()
    assert me["organization"]["code"] == "inst-b" and me["national_researcher_number"] == "10000001"


def test_same_org_is_idempotent(seeded: PgUrls, keycloak: FakeKeycloakAdmin) -> None:
    client = client_with(seeded, keycloak)
    org_a = ORGS_BY_CODE["inst-a"].organization_id
    response = client.post(
        f"/api/v1/users/{RESEARCHER.user_id}/transfer",
        json={"organization_id": str(org_a)},
        headers=bearer(token_for(ADMIN)),
    )
    assert response.status_code == 200
    assert keycloak.calls == [(RESEARCHER.user_id, "inst-a")]
    assert events(seeded, "identity.membership.changed.v1") == []


def test_keycloak_failure_rolls_back(seeded: PgUrls, keycloak: FakeKeycloakAdmin) -> None:
    keycloak.fail = True
    client = client_with(seeded, keycloak)
    response = client.post(
        f"/api/v1/users/{RESEARCHER.user_id}/transfer",
        json={"organization_id": str(INST_B)},
        headers=bearer(token_for(ADMIN)),
    )
    assert response.status_code == 503
    assert_matches_response("transferUserOrganization", 503, response.json())
    assert (
        scalar(
            seeded,
            "SELECT count(*) FROM identity.organization_memberships WHERE user_id = :u",
            u=RESEARCHER.user_id,
        )
        == 1
    )
    assert events(seeded, "identity.membership.changed.v1") == []


@pytest.mark.parametrize(
    ("actor", "status"), [("a.admin@inst-a.local", 403), ("a.researcher@inst-a.local", 403)]
)
def test_only_platform_admin(seeded: PgUrls, keycloak: FakeKeycloakAdmin, actor: str, status: int) -> None:
    response = client_with(seeded, keycloak).post(
        f"/api/v1/users/{RESEARCHER.user_id}/transfer",
        json={"organization_id": str(INST_B)},
        headers=bearer(token_for(actor)),
    )
    assert response.status_code == status


def test_unknown_user_or_org(seeded: PgUrls, keycloak: FakeKeycloakAdmin) -> None:
    client = client_with(seeded, keycloak)
    missing = "00000000-0000-7000-8000-00000000ffff"
    assert (
        client.post(
            f"/api/v1/users/{missing}/transfer",
            json={"organization_id": str(INST_B)},
            headers=bearer(token_for(ADMIN)),
        ).status_code
        == 404
    )
    bad_org = client.post(
        f"/api/v1/users/{RESEARCHER.user_id}/transfer",
        json={"organization_id": missing},
        headers=bearer(token_for(ADMIN)),
    )
    assert bad_org.status_code == 422
    assert bad_org.json()["error"]["details"]["fields"] == [
        {"field": "organization_id", "reason": "UNKNOWN_ORGANIZATION"}
    ]
