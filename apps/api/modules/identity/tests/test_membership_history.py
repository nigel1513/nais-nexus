"""Membership history: an ended membership is kept but never joined into current reads (spec §3.0b)."""

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError

from api.modules.identity.query import SqlIdentityQuery
from api.modules.identity.seed_data import ORGS_BY_CODE, USERS_BY_EMAIL
from api.modules.identity.tests.support import bearer, make_client, token_for
from api.platform.db import session_scope
from api.platform.testing.fixtures import PgUrls

RESEARCHER = USERS_BY_EMAIL["a.researcher@inst-a.local"]
INST_A = ORGS_BY_CODE["inst-a"].organization_id
INST_B = ORGS_BY_CODE["inst-b"].organization_id


def move_researcher_to_b(urls: PgUrls) -> None:
    engine = create_engine(urls.migrator)
    with engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE identity.organization_memberships SET ended_at = now(), status = 'DISABLED', roles = '{}'"
                " WHERE user_id = :u AND ended_at IS NULL"
            ),
            {"u": RESEARCHER.user_id},
        )
        conn.execute(
            text(
                "INSERT INTO identity.organization_memberships (membership_id, user_id, organization_id)"
                " VALUES (gen_random_uuid(), :u, :o)"
            ),
            {"u": RESEARCHER.user_id, "o": INST_B},
        )
    engine.dispose()


def test_history_rows_never_duplicate_reads(seeded: PgUrls) -> None:
    move_researcher_to_b(seeded)
    port = SqlIdentityQuery(lambda: session_scope(seeded.app))
    profiles = port.get_public_profiles([RESEARCHER.user_id])
    assert profiles[RESEARCHER.user_id].organization_id == INST_B
    assert port.is_active_user(RESEARCHER.user_id)
    client = make_client(seeded)
    me = client.get("/api/v1/me", headers=bearer(token_for(RESEARCHER.email, org_code="inst-b")))
    assert me.status_code == 200, me.text
    assert me.json()["organization"]["code"] == "inst-b"
    listed = client.get(
        "/api/v1/users",
        params={"q": "A Researcher"},
        headers=bearer(token_for(RESEARCHER.email, org_code="inst-b")),
    ).json()["items"]
    assert [item["organization_id"] for item in listed] == [str(INST_B)]
    members_a = client.get(
        f"/api/v1/organizations/{INST_A}/members", headers=bearer(token_for("a.admin@inst-a.local"))
    ).json()["items"]
    assert str(RESEARCHER.user_id) not in {m["user_id"] for m in members_a}


def test_old_org_token_is_rejected_after_move(seeded: PgUrls) -> None:
    move_researcher_to_b(seeded)
    response = make_client(seeded).get("/api/v1/me", headers=bearer(token_for(RESEARCHER.email)))
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ORGANIZATION_UNKNOWN"


def test_two_current_memberships_are_impossible(seeded: PgUrls) -> None:
    engine = create_engine(seeded.migrator)
    with pytest.raises(IntegrityError), engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO identity.organization_memberships (membership_id, user_id, organization_id)"
                " VALUES (gen_random_uuid(), :u, :o)"
            ),
            {"u": RESEARCHER.user_id, "o": INST_B},
        )
    engine.dispose()


def test_seed_does_not_move_a_transferred_user_back(seeded: PgUrls) -> None:
    from api.modules.identity.tests.support import seed_all

    move_researcher_to_b(seeded)
    seed_all(seeded)
    port = SqlIdentityQuery(lambda: session_scope(seeded.app))
    assert port.get_public_profiles([RESEARCHER.user_id])[RESEARCHER.user_id].organization_id == INST_B
