from typing import Any

import pytest
from sqlalchemy import false, text

from api.modules.identity import transfer
from api.modules.identity.keycloak_admin import FakeKeycloakAdmin, KeycloakAdminPort
from api.modules.identity.seed_data import ORGS_BY_CODE, USERS_BY_EMAIL
from api.modules.identity.tests.support import bearer, events, make_client, scalar, token_for
from api.platform import ports
from api.platform.db import session_factory
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
    assert keycloak.calls == [(RESEARCHER.keycloak_sub, "inst-b")]
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
    assert keycloak.calls == [(RESEARCHER.keycloak_sub, "inst-a")]
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


def test_keycloak_receives_the_sub_not_the_user_id(seeded: PgUrls, keycloak: FakeKeycloakAdmin) -> None:
    with session_factory(seeded.app)() as session:
        session.execute(
            text("UPDATE identity.users SET keycloak_sub = 'kc-sub-xyz' WHERE user_id = :u"),
            {"u": RESEARCHER.user_id},
        )
        session.commit()
    response = client_with(seeded, keycloak).post(
        f"/api/v1/users/{RESEARCHER.user_id}/transfer",
        json={"organization_id": str(INST_B)},
        headers=bearer(token_for(ADMIN)),
    )
    assert response.status_code == 200, response.text
    assert keycloak.calls == [("kc-sub-xyz", "inst-b")]


def test_user_without_current_membership(seeded: PgUrls, keycloak: FakeKeycloakAdmin) -> None:
    with session_factory(seeded.app)() as session:
        session.execute(
            text(
                "UPDATE identity.organization_memberships SET status='DISABLED', roles='{}', ended_at=now() "
                "WHERE user_id = :u"
            ),
            {"u": RESEARCHER.user_id},
        )
        session.commit()
    response = client_with(seeded, keycloak).post(
        f"/api/v1/users/{RESEARCHER.user_id}/transfer",
        json={"organization_id": str(INST_B)},
        headers=bearer(token_for(ADMIN)),
    )
    assert response.status_code == 200, response.text
    assert response.json()["organization_id"] == str(INST_B)
    assert [e["payload"]["status"] for e in events(seeded, "identity.membership.changed.v1")] == ["ACTIVE"]


def test_unique_violation_maps_to_409(
    seeded: PgUrls, keycloak: FakeKeycloakAdmin, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Simulate losing a race: the old membership stays current, so opening the new one violates uq_memberships_current.
    real_update = transfer.update
    monkeypatch.setattr(transfer, "update", lambda table: real_update(table).where(false()))
    response = client_with(seeded, keycloak).post(
        f"/api/v1/users/{RESEARCHER.user_id}/transfer",
        json={"organization_id": str(INST_B)},
        headers=bearer(token_for(ADMIN)),
    )
    assert response.status_code == 409, response.text
    assert keycloak.calls == []
    assert events(seeded, "identity.membership.changed.v1") == []


def test_last_org_admin_cannot_be_transferred_away(seeded: PgUrls, keycloak: FakeKeycloakAdmin) -> None:
    client = client_with(seeded, keycloak)
    a_admin = USERS_BY_EMAIL["a.admin@inst-a.local"]
    response = client.post(
        f"/api/v1/users/{a_admin.user_id}/transfer",
        json={"organization_id": str(INST_B), "roles": ["DATA_STEWARD"]},
        headers=bearer(token_for(ADMIN)),
    )
    assert response.status_code == 409, response.text
    error = response.json()["error"]
    assert error["code"] == "CONFLICT" and error["details"]["reason"] == "LAST_ORG_ADMIN"
    assert keycloak.calls == []
    assert events(seeded, "identity.membership.changed.v1") == []


def test_org_admin_can_be_transferred_when_another_admin_remains(
    seeded: PgUrls, keycloak: FakeKeycloakAdmin
) -> None:
    client = client_with(seeded, keycloak)
    a_admin = USERS_BY_EMAIL["a.admin@inst-a.local"]
    org_a = ORGS_BY_CODE["inst-a"].organization_id
    with session_factory(seeded.app)() as session, session.begin():  # promote a second admin in inst-a
        session.execute(
            text(
                "UPDATE identity.organization_memberships SET roles = ARRAY['ORG_ADMIN'] "
                "WHERE user_id = :u AND ended_at IS NULL"
            ),
            {"u": RESEARCHER.user_id},
        )
    response = client.post(
        f"/api/v1/users/{a_admin.user_id}/transfer",
        json={"organization_id": str(INST_B)},
        headers=bearer(token_for(ADMIN)),
    )
    assert response.status_code == 200, response.text
    assert org_a != INST_B
