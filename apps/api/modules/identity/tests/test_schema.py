import uuid
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.modules.identity.tests.support import scalar
from api.platform.db import session_scope
from api.platform.testing.fixtures import PgUrls


def add_org(session: Session, code: str = "inst-x", type_: str = "RESEARCH_INSTITUTE") -> uuid.UUID:
    org_id = uuid.uuid4()
    session.execute(
        text(
            "INSERT INTO identity.organizations (organization_id, code, name, type) VALUES (:i, :c, 'X', :t)"
        ),
        {"i": org_id, "c": code, "t": type_},
    )
    return org_id


def add_user(session: Session, email: str = "x@inst-x.local", **extra: Any) -> uuid.UUID:
    user_id = uuid.uuid4()
    session.execute(
        text(
            "INSERT INTO identity.users (user_id, keycloak_sub, email, display_name, platform_roles) "
            "VALUES (:i, :s, :e, 'X', :p)"
        ),
        {"i": user_id, "s": str(user_id), "e": email, "p": extra.get("platform_roles", [])},
    )
    return user_id


def add_membership(session: Session, user_id: uuid.UUID, org_id: uuid.UUID, roles: list[str]) -> None:
    session.execute(
        text(
            "INSERT INTO identity.organization_memberships (membership_id, user_id, organization_id, roles) "
            "VALUES (:m, :u, :o, :r)"
        ),
        {"m": uuid.uuid4(), "u": user_id, "o": org_id, "r": roles},
    )


def test_version_table_lives_in_identity_schema(db: PgUrls) -> None:
    assert scalar(db, "SELECT version_num FROM identity.alembic_version") == "identity_0002"


def test_app_role_can_write_every_table_with_defaults(db: PgUrls) -> None:
    with session_scope(db.app) as session:
        org_id = add_org(session)
        user_id = add_user(session)
        add_membership(session, user_id, org_id, ["DATA_STEWARD"])
        session.execute(
            text("INSERT INTO identity.user_sessions (session_id, user_id) VALUES ('s-1', :u)"),
            {"u": user_id},
        )
    assert scalar(db, "SELECT status FROM identity.users WHERE user_id = :u", u=user_id) == "ACTIVE"
    assert scalar(db, "SELECT platform_roles FROM identity.users WHERE user_id = :u", u=user_id) == []
    assert (
        scalar(db, "SELECT status FROM identity.organization_memberships WHERE user_id = :u", u=user_id)
        == "ACTIVE"
    )
    assert scalar(db, "SELECT count(*) FROM identity.user_sessions") == 1


@pytest.mark.parametrize("code", ["Inst-A", "a", "inst_a", "inst a"])
def test_org_code_must_match_pattern(db: PgUrls, code: str) -> None:
    with pytest.raises(IntegrityError), session_scope(db.app) as session:
        add_org(session, code=code)


def test_org_type_is_restricted(db: PgUrls) -> None:
    with pytest.raises(IntegrityError), session_scope(db.app) as session:
        add_org(session, type_="HOSPITAL")


def test_email_is_stored_lowercase_only(db: PgUrls) -> None:
    with pytest.raises(IntegrityError), session_scope(db.app) as session:
        add_user(session, email="Upper@inst-x.local")


def test_platform_roles_are_restricted(db: PgUrls) -> None:
    with pytest.raises(IntegrityError), session_scope(db.app) as session:
        add_user(session, platform_roles=["ORG_ADMIN"])


def test_membership_roles_are_restricted(db: PgUrls) -> None:
    with pytest.raises(IntegrityError), session_scope(db.app) as session:
        add_membership(session, add_user(session), add_org(session), ["PLATFORM_ADMIN"])


def test_one_membership_per_user(db: PgUrls) -> None:
    with pytest.raises(IntegrityError), session_scope(db.app) as session:
        user_id = add_user(session)
        add_membership(session, user_id, add_org(session, code="inst-x"), [])
        add_membership(session, user_id, add_org(session, code="inst-y"), [])


def test_search_indexes_exist(db: PgUrls) -> None:
    names = scalar(
        db, "SELECT array_agg(indexname ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'identity'"
    )
    for index in (
        "ix_users_display_name_trgm",
        "ix_users_email_prefix",
        "ix_memberships_org_status",
        "ix_memberships_roles",
        "ix_user_sessions_user",
    ):
        assert index in names


def test_identity_0002_columns_and_partial_unique(identity_db: PgUrls) -> None:
    from sqlalchemy import create_engine, text

    engine = create_engine(identity_db.migrator)
    with engine.connect() as conn:
        cols = {
            r[0]
            for r in conn.execute(
                text(
                    "SELECT table_name || '.' || column_name FROM information_schema.columns"
                    " WHERE table_schema = 'identity'"
                )
            )
        }
        index = conn.execute(
            text(
                "SELECT indexdef FROM pg_indexes WHERE schemaname='identity' AND indexname='uq_memberships_current'"
            )
        ).scalar_one()
    engine.dispose()
    assert {
        "users.national_researcher_number",
        "organization_memberships.started_at",
        "organization_memberships.ended_at",
    } <= cols
    assert "WHERE (ended_at IS NULL)" in index
