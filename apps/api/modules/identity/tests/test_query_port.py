import uuid

import pytest
from sqlalchemy import text

from api.modules.identity import wire_ports
from api.modules.identity.public import IdentityQueryPort
from api.modules.identity.query import SqlIdentityQuery
from api.modules.identity.seed_data import ORGS_BY_CODE, USERS_BY_EMAIL
from api.platform import ports
from api.platform.db import session_scope
from api.platform.testing.fixtures import PgUrls

INST_A = ORGS_BY_CODE["inst-a"].organization_id
INST_B = ORGS_BY_CODE["inst-b"].organization_id
UNKNOWN = uuid.UUID("00000000-0000-7000-8000-00000000ffff")


def uid(email: str) -> uuid.UUID:
    return USERS_BY_EMAIL[email].user_id


@pytest.fixture
def port(seeded: PgUrls) -> SqlIdentityQuery:
    return SqlIdentityQuery(lambda: session_scope(seeded.app))


def test_port_is_provided_by_wire(seeded: PgUrls) -> None:
    wire_ports(lambda: session_scope(seeded.app))
    assert isinstance(ports.get(IdentityQueryPort), SqlIdentityQuery)


def test_public_profile(port: SqlIdentityQuery) -> None:
    profile = port.get_public_profile(uid("a.researcher@inst-a.local"))
    assert profile is not None
    assert profile.display_name == "A Researcher"
    assert profile.organization_id == INST_A and profile.organization_name == "Institute A"
    assert profile.status == "ACTIVE"
    disabled = port.get_public_profile(uid("b.disabled@inst-b.local"))
    assert disabled is not None and disabled.status == "DISABLED"
    assert port.get_public_profile(UNKNOWN) is None


def test_public_profiles_batch(port: SqlIdentityQuery) -> None:
    a, b = uid("a.researcher@inst-a.local"), uid("b.researcher@inst-b.local")
    profiles = port.get_public_profiles([a, b, UNKNOWN])
    assert set(profiles) == {a, b}
    assert profiles[b].organization_id == INST_B
    assert port.get_public_profiles([]) == {}


def test_organization_summary(port: SqlIdentityQuery) -> None:
    summary = port.get_organization_summary(INST_B)
    assert summary is not None and summary.code == "inst-b" and summary.type == "RESEARCH_INSTITUTE"
    assert port.get_organization_summary(UNKNOWN) is None


def test_is_active_user(port: SqlIdentityQuery, seeded: PgUrls) -> None:
    assert port.is_active_user(uid("a.researcher@inst-a.local")) is True
    assert port.is_active_user(uid("b.disabled@inst-b.local")) is False
    assert port.is_active_user(UNKNOWN) is False
    with session_scope(seeded.app) as session:
        session.execute(
            text("UPDATE identity.users SET status = 'DISABLED' WHERE user_id = :u"),
            {"u": uid("a.researcher@inst-a.local")},
        )
    assert port.is_active_user(uid("a.researcher@inst-a.local")) is False


def test_has_org_role(port: SqlIdentityQuery) -> None:
    assert port.has_org_role(uid("a.admin@inst-a.local"), INST_A, "ORG_ADMIN") is True
    assert port.has_org_role(uid("a.admin@inst-a.local"), INST_B, "ORG_ADMIN") is False
    assert port.has_org_role(uid("a.researcher@inst-a.local"), INST_A, "DATA_STEWARD") is False
    assert port.has_org_role(uid("b.steward@inst-b.local"), INST_B, "DATA_STEWARD") is True


def test_list_users_with_org_role_only_active(port: SqlIdentityQuery, seeded: PgUrls) -> None:
    assert port.list_users_with_org_role(INST_A, "ORG_ADMIN") == [uid("a.admin@inst-a.local")]
    assert port.list_users_with_org_role(INST_B, "DATA_STEWARD") == [uid("b.steward@inst-b.local")]
    with session_scope(seeded.app) as session:
        session.execute(
            text("UPDATE identity.organization_memberships SET status = 'DISABLED' WHERE user_id = :u"),
            {"u": uid("b.steward@inst-b.local")},
        )
    assert port.list_users_with_org_role(INST_B, "DATA_STEWARD") == []


def test_get_email(port: SqlIdentityQuery) -> None:
    assert port.get_email(uid("a.researcher@inst-a.local")) == "a.researcher@inst-a.local"
    assert port.get_email(UNKNOWN) is None
