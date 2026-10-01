import json
import uuid

import pytest
from sqlalchemy import text

from api.modules.identity import MODULE
from api.modules.identity.seed import seed
from api.modules.identity.seed_data import ORGANIZATIONS, ORGS_BY_CODE, USERS, USERS_BY_EMAIL
from api.modules.identity.tests.support import events, scalar, seed_all
from api.platform.db import session_scope
from api.platform.seed import run_seed
from api.platform.settings import REPO_ROOT
from api.platform.testing.contracts import assert_valid_event
from api.platform.testing.fixtures import PgUrls

ORG_CREATED = "identity.organization.created.v1"
USER_CREATED = "identity.user.created.v1"


def membership(db: PgUrls, email: str, column: str) -> object:
    user_id = USERS_BY_EMAIL[email].user_id
    return scalar(db, f"SELECT {column} FROM identity.organization_memberships WHERE user_id = :u", u=user_id)


def test_seed_creates_orgs_users_and_memberships(db: PgUrls) -> None:
    seed_all(db)
    assert scalar(db, "SELECT count(*) FROM identity.organizations") == 3
    assert scalar(db, "SELECT count(*) FROM identity.users") == 8
    assert scalar(db, "SELECT count(*) FROM identity.organization_memberships") == 8
    admin = USERS_BY_EMAIL["admin@nais.local"]
    assert scalar(db, "SELECT platform_roles FROM identity.users WHERE user_id = :u", u=admin.user_id) == [
        "PLATFORM_ADMIN"
    ]
    assert scalar(db, "SELECT keycloak_sub FROM identity.users WHERE user_id = :u", u=admin.user_id) == str(
        admin.user_id
    )
    assert membership(db, "admin@nais.local", "roles") == ["ORG_ADMIN"]
    assert membership(db, "a.steward@inst-a.local", "roles") == ["DATA_STEWARD"]
    assert (
        membership(db, "a.steward@inst-a.local", "organization_id") == ORGS_BY_CODE["inst-a"].organization_id
    )
    assert membership(db, "b.disabled@inst-b.local", "status") == "DISABLED"
    assert membership(db, "b.researcher@inst-b.local", "roles") == []


def test_seed_emits_valid_system_events_with_one_correlation_id(db: PgUrls) -> None:
    seed_all(db)
    created = events(db, ORG_CREATED) + events(db, USER_CREATED)
    assert len(events(db, ORG_CREATED)) == 3
    assert len(events(db, USER_CREATED)) == 8
    for envelope in created:
        assert_valid_event(envelope)
        assert envelope["actor"] == {"type": "SYSTEM", "user_id": None, "organization_id": None}
    assert len({envelope["correlation_id"] for envelope in created}) == 1


def test_seed_is_idempotent_and_restores_seed_values(db: PgUrls) -> None:
    seed_all(db)
    researcher = USERS_BY_EMAIL["a.researcher@inst-a.local"]
    with session_scope(db.app) as session:
        session.execute(
            text(
                "UPDATE identity.organization_memberships SET roles = '{ORG_ADMIN}', status = 'DISABLED' "
                "WHERE user_id = :u"
            ),
            {"u": researcher.user_id},
        )
    seed_all(db)
    assert scalar(db, "SELECT count(*) FROM identity.users") == 8
    assert scalar(db, "SELECT count(*) FROM identity.organization_memberships") == 8
    assert len(events(db, ORG_CREATED)) == 3
    assert len(events(db, USER_CREATED)) == 8
    assert membership(db, "a.researcher@inst-a.local", "roles") == []
    assert membership(db, "a.researcher@inst-a.local", "status") == "ACTIVE"


def test_seed_refuses_a_user_that_took_a_seed_sub(db: PgUrls) -> None:
    researcher = USERS_BY_EMAIL["a.researcher@inst-a.local"]
    with session_scope(db.app) as session:
        session.execute(
            text(
                "INSERT INTO identity.users (user_id, keycloak_sub, email, display_name) "
                "VALUES (:i, :s, 'someone@inst-a.local', 'Someone')"
            ),
            {"i": uuid.uuid4(), "s": researcher.keycloak_sub},
        )
    with pytest.raises(RuntimeError, match="a.researcher@inst-a.local"):
        seed_all(db)
    assert scalar(db, "SELECT count(*) FROM identity.organizations") == 0  # whole seed rolled back


def test_module_exposes_seed_to_the_platform_orchestrator(db: PgUrls) -> None:
    assert MODULE.seed is seed
    assert run_seed([MODULE], url=db.app) == ["identity"]
    assert scalar(db, "SELECT count(*) FROM identity.users") == 8


def test_seed_ids_file_matches_seed_data() -> None:
    data = json.loads((REPO_ROOT / "infra" / "keycloak" / "seed_ids.json").read_text(encoding="utf-8"))
    assert data["organizations"] == {org.code: str(org.organization_id) for org in ORGANIZATIONS}
    assert data["users"] == {user.email: str(user.user_id) for user in USERS}
