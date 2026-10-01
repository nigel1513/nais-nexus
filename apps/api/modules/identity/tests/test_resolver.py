import hashlib
import threading
import uuid
from typing import Any

import pytest
from sqlalchemy import text

from api.modules.identity.resolver import IdentityPrincipalResolver, session_id_for
from api.modules.identity.seed_data import ORGS_BY_CODE, USERS_BY_EMAIL
from api.modules.identity.tests.support import claims_for, events, scalar
from api.platform.auth import CurrentUser
from api.platform.db import session_scope
from api.platform.errors import ApiError
from api.platform.testing.contracts import assert_valid_event
from api.platform.testing.fixtures import PgUrls

LOGGED_IN = "identity.user.logged_in.v1"
USER_CREATED = "identity.user.created.v1"
RESEARCHER = "a.researcher@inst-a.local"


def resolver_for(urls: PgUrls) -> IdentityPrincipalResolver:
    return IdentityPrincipalResolver(lambda: session_scope(urls.app))


def resolve(urls: PgUrls, claims: dict[str, Any]) -> CurrentUser:
    return resolver_for(urls).resolve(claims, uuid.uuid4())


def error_of(urls: PgUrls, claims: dict[str, Any]) -> str:
    with pytest.raises(ApiError) as caught:
        resolve(urls, claims)
    return caught.value.code.value


def execute(urls: PgUrls, sql: str, **params: Any) -> None:
    with session_scope(urls.app) as session:
        session.execute(text(sql), params)


def new_user_claims(**overrides: Any) -> dict[str, Any]:
    claims: dict[str, Any] = {
        "sub": "kc-new-user",
        "email": "new.user@inst-a.local",
        "name": "New User",
        "org_code": "inst-a",
        "sid": "s-new",
        "iat": 1_790_000_000,
    }
    claims.update(overrides)
    return claims


# --- existing users (M01-AT-01, AT-03, AT-04, AT-05, AT-15) ---


def test_seed_users_resolve_to_their_institute(seeded: PgUrls) -> None:
    a = resolve(seeded, claims_for(RESEARCHER))
    b = resolve(seeded, claims_for("b.researcher@inst-b.local"))
    assert a.user_id == USERS_BY_EMAIL[RESEARCHER].user_id
    assert a.organization_id == ORGS_BY_CODE["inst-a"].organization_id
    assert b.organization_id == ORGS_BY_CODE["inst-b"].organization_id
    assert a.org_roles == frozenset() and a.platform_roles == frozenset()
    assert a.session_id == "s-1" and a.display_name == "A Researcher"


def test_roles_come_from_the_database(seeded: PgUrls) -> None:
    admin = resolve(seeded, claims_for("admin@nais.local"))
    assert admin.is_platform_admin
    assert admin.has_org_role(ORGS_BY_CODE["nais"].organization_id, "ORG_ADMIN")
    steward = resolve(seeded, claims_for("a.steward@inst-a.local"))
    assert steward.org_roles == frozenset({"DATA_STEWARD"})


def test_role_changes_apply_on_the_next_request(seeded: PgUrls) -> None:
    claims = claims_for(RESEARCHER)
    assert resolve(seeded, claims).org_roles == frozenset()
    execute(
        seeded,
        "UPDATE identity.organization_memberships SET roles = '{DATA_STEWARD}' WHERE user_id = :u",
        u=USERS_BY_EMAIL[RESEARCHER].user_id,
    )
    assert resolve(seeded, claims).org_roles == frozenset({"DATA_STEWARD"})


def test_login_event_once_per_session(seeded: PgUrls) -> None:
    user_id = str(USERS_BY_EMAIL[RESEARCHER].user_id)
    correlation_id = uuid.uuid4()
    for _ in range(3):
        resolver_for(seeded).resolve(claims_for(RESEARCHER, sid="sess-1"), correlation_id)
    logged = events(seeded, LOGGED_IN, user_id=user_id)
    assert len(logged) == 1
    assert_valid_event(logged[0])
    assert logged[0]["payload"] == {
        "user_id": user_id,
        "organization_id": str(ORGS_BY_CODE["inst-a"].organization_id),
        "session_id": "sess-1",
    }
    assert logged[0]["actor"] == {
        "type": "USER",
        "user_id": user_id,
        "organization_id": str(ORGS_BY_CODE["inst-a"].organization_id),
    }
    assert logged[0]["correlation_id"] == str(correlation_id)
    assert scalar(
        seeded,
        "SELECT last_login_at IS NOT NULL FROM identity.users WHERE user_id = :u",
        u=USERS_BY_EMAIL[RESEARCHER].user_id,
    )

    resolve(seeded, claims_for(RESEARCHER, sid="sess-2"))
    assert [e["payload"]["session_id"] for e in events(seeded, LOGGED_IN, user_id=user_id)] == [
        "sess-1",
        "sess-2",
    ]


def test_session_id_fallbacks(seeded: PgUrls) -> None:
    no_sid = claims_for(RESEARCHER, sid=None, iat=1_790_000_000)
    expected = hashlib.sha256(f"{no_sid['sub']}:1790000000".encode()).hexdigest()
    assert session_id_for(no_sid) == expected
    long_sid = "x" * 100
    assert (
        session_id_for(claims_for(RESEARCHER, sid=long_sid)) == hashlib.sha256(long_sid.encode()).hexdigest()
    )

    assert resolve(seeded, no_sid).session_id == expected
    assert resolve(seeded, no_sid).session_id == expected
    assert len(resolve(seeded, claims_for(RESEARCHER, sid=long_sid)).session_id) == 64
    user_id = str(USERS_BY_EMAIL[RESEARCHER].user_id)
    assert len(events(seeded, LOGGED_IN, user_id=user_id)) == 2


def test_disabled_membership_is_rejected_without_login_event(seeded: PgUrls) -> None:
    assert error_of(seeded, claims_for("b.disabled@inst-b.local")) == "MEMBERSHIP_DISABLED"
    disabled_id = str(USERS_BY_EMAIL["b.disabled@inst-b.local"].user_id)
    assert events(seeded, LOGGED_IN, user_id=disabled_id) == []


def test_disabled_user_is_rejected(seeded: PgUrls) -> None:
    execute(
        seeded,
        "UPDATE identity.users SET status = 'DISABLED' WHERE user_id = :u",
        u=USERS_BY_EMAIL[RESEARCHER].user_id,
    )
    assert error_of(seeded, claims_for(RESEARCHER)) == "USER_DISABLED"


@pytest.mark.parametrize("org_code", ["unknown-org", None, 42])
def test_unknown_or_missing_org_code_is_rejected(seeded: PgUrls, org_code: object) -> None:
    claims = claims_for(RESEARCHER)
    if org_code is None:
        del claims["org_code"]
    else:
        claims["org_code"] = org_code
    assert error_of(seeded, claims) == "ORGANIZATION_UNKNOWN"


def test_token_org_must_match_membership_org(seeded: PgUrls) -> None:
    assert error_of(seeded, claims_for(RESEARCHER, org_code="inst-b")) == "ORGANIZATION_UNKNOWN"


@pytest.mark.parametrize("sub", ["", None, "s" * 65])
def test_unusable_sub_is_unauthenticated(seeded: PgUrls, sub: object) -> None:
    assert error_of(seeded, claims_for(RESEARCHER, sub=sub)) == "UNAUTHENTICATED"


# --- JIT provisioning (M01-AT-02, AT-07) ---


def test_first_request_provisions_user_and_membership(seeded: PgUrls) -> None:
    correlation_id = uuid.uuid4()
    user = resolver_for(seeded).resolve(new_user_claims(email="New.User@Inst-A.local"), correlation_id)
    assert user.organization_id == ORGS_BY_CODE["inst-a"].organization_id
    assert user.org_roles == frozenset() and user.display_name == "New User"
    assert scalar(seeded, "SELECT email FROM identity.users WHERE keycloak_sub = 'kc-new-user'") == (
        "new.user@inst-a.local"
    )
    assert (
        scalar(
            seeded, "SELECT roles FROM identity.organization_memberships WHERE user_id = :u", u=user.user_id
        )
        == []
    )
    created = events(seeded, USER_CREATED, user_id=str(user.user_id))
    assert len(created) == 1
    assert_valid_event(created[0])
    assert created[0]["payload"] == {
        "user_id": str(user.user_id),
        "organization_id": str(ORGS_BY_CODE["inst-a"].organization_id),
        "display_name": "New User",
        "email": "new.user@inst-a.local",
    }
    assert created[0]["actor"]["type"] == "USER" and created[0]["actor"]["user_id"] == str(user.user_id)
    assert created[0]["correlation_id"] == str(correlation_id)
    assert len(events(seeded, LOGGED_IN, user_id=str(user.user_id))) == 1

    again = resolve(seeded, new_user_claims(sid="s-new-2"))
    assert again.user_id == user.user_id
    assert len(events(seeded, USER_CREATED, user_id=str(user.user_id))) == 1


def test_display_name_falls_back_to_username_then_email(seeded: PgUrls) -> None:
    claims = new_user_claims(preferred_username="newbie")
    del claims["name"]
    assert resolve(seeded, claims).display_name == "newbie"
    bare = new_user_claims(sub="kc-bare", email="bare.person@inst-a.local", sid="s-bare")
    del bare["name"]
    assert resolve(seeded, bare).display_name == "bare.person"


def test_email_owned_by_another_sub_is_conflict(seeded: PgUrls) -> None:
    claims = new_user_claims(sub="kc-imposter", email="A.Researcher@inst-a.local")
    assert error_of(seeded, claims) == "CONFLICT"
    assert scalar(seeded, "SELECT count(*) FROM identity.users WHERE keycloak_sub = 'kc-imposter'") == 0


def test_unknown_org_provisions_nothing(seeded: PgUrls) -> None:
    assert error_of(seeded, new_user_claims(org_code="unknown-org")) == "ORGANIZATION_UNKNOWN"
    assert scalar(seeded, "SELECT count(*) FROM identity.users WHERE keycloak_sub = 'kc-new-user'") == 0
    assert events(seeded, USER_CREATED, email="new.user@inst-a.local") == []


def test_missing_email_cannot_provision(seeded: PgUrls) -> None:
    claims = new_user_claims()
    del claims["email"]
    assert error_of(seeded, claims) == "UNAUTHENTICATED"


def test_parallel_first_requests_provision_once(seeded: PgUrls) -> None:
    resolver = resolver_for(seeded)
    barrier = threading.Barrier(4)
    results: list[CurrentUser] = []
    errors: list[BaseException] = []

    def call() -> None:
        barrier.wait()
        try:
            results.append(resolver.resolve(new_user_claims(), uuid.uuid4()))
        except BaseException as exc:  # collected and asserted below
            errors.append(exc)

    threads = [threading.Thread(target=call) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []
    assert len({user.user_id for user in results}) == 1
    user_id = str(results[0].user_id)
    assert scalar(seeded, "SELECT count(*) FROM identity.users WHERE keycloak_sub = 'kc-new-user'") == 1
    assert len(events(seeded, USER_CREATED, user_id=user_id)) == 1
    assert len(events(seeded, LOGGED_IN, user_id=user_id)) == 1
