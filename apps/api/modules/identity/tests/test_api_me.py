import pytest
from fastapi import APIRouter

from api.modules.identity.seed_data import ORGS_BY_CODE, USERS_BY_EMAIL
from api.modules.identity.tests.support import ISSUER, bearer, events, make_client, scalar, token_for
from api.platform.auth import CurrentUserDep
from api.platform.modules import ModuleSpec
from api.platform.testing.contracts import assert_matches_response, assert_valid_event
from api.platform.testing.fixtures import PgUrls
from api.platform.testing.tokens import FakeIssuer

LOGGED_IN = "identity.user.logged_in.v1"
USER_CREATED = "identity.user.created.v1"
RESEARCHER = "a.researcher@inst-a.local"


def probe_module() -> ModuleSpec:
    """Stand-ins for other modules' endpoints: every route depends on CurrentUser, like M02/M03 will."""
    router = APIRouter()

    @router.get("/projects")
    def projects(user: CurrentUserDep) -> dict[str, str]:
        return {"user_id": str(user.user_id)}

    @router.get("/datasets")
    def datasets(user: CurrentUserDep) -> dict[str, str]:
        return {"user_id": str(user.user_id)}

    return ModuleSpec(name="probe", router=router)


def test_me_for_each_institute(seeded: PgUrls) -> None:  # M01-AT-01
    client = make_client(seeded)
    for email, code in ((RESEARCHER, "inst-a"), ("b.researcher@inst-b.local", "inst-b")):
        response = client.get("/api/v1/me", headers=bearer(token_for(email)))
        assert response.status_code == 200, response.text
        body = response.json()
        assert_matches_response("getMe", 200, body)
        assert body["organization"]["code"] == code
        assert body["user_id"] == str(USERS_BY_EMAIL[email].user_id)
        assert body["email"] == email
        assert body["status"] == "ACTIVE"
        assert body["org_roles"] == [] and body["platform_roles"] == []


def test_me_lists_roles(seeded: PgUrls) -> None:
    client = make_client(seeded)
    admin = client.get("/api/v1/me", headers=bearer(token_for("admin@nais.local"))).json()
    assert admin["platform_roles"] == ["PLATFORM_ADMIN"]
    assert admin["org_roles"] == ["ORG_ADMIN"]
    assert admin["organization"] == {
        "organization_id": str(ORGS_BY_CODE["nais"].organization_id),
        "code": "nais",
        "name": "NAIS",
        "type": "PLATFORM_OPERATOR",
    }


def test_first_call_provisions_new_user(seeded: PgUrls) -> None:  # M01-AT-02
    token = ISSUER.token(
        sub="kc-fresh", email="fresh@inst-a.local", name="Fresh Person", org_code="inst-a", sid="s-fresh"
    )
    response = make_client(seeded).get("/api/v1/me", headers=bearer(token))
    assert response.status_code == 200, response.text
    body = response.json()
    assert_matches_response("getMe", 200, body)
    assert body["org_roles"] == [] and body["organization"]["code"] == "inst-a"
    created = events(seeded, USER_CREATED, email="fresh@inst-a.local")
    assert len(created) == 1
    assert_valid_event(created[0])
    assert created[0]["correlation_id"] == response.headers["x-request-id"]


def test_login_event_once_per_session(seeded: PgUrls) -> None:  # M01-AT-03, M01-AT-04
    client = make_client(seeded)
    user_id = str(USERS_BY_EMAIL[RESEARCHER].user_id)
    first = bearer(token_for(RESEARCHER, sid="sess-1"))
    for _ in range(3):
        assert client.get("/api/v1/me", headers=first).status_code == 200
    assert len(events(seeded, LOGGED_IN, user_id=user_id)) == 1
    assert client.get("/api/v1/me", headers=bearer(token_for(RESEARCHER, sid="sess-2"))).status_code == 200
    logged = events(seeded, LOGGED_IN, user_id=user_id)
    assert [e["payload"]["session_id"] for e in logged] == ["sess-1", "sess-2"]
    for envelope in logged:
        assert_valid_event(envelope)


def test_disabled_membership_blocks_every_request(seeded: PgUrls) -> None:  # M01-AT-05
    client = make_client(seeded, probe_module())
    headers = bearer(token_for("b.disabled@inst-b.local"))
    for path in ("/api/v1/me", "/api/v1/projects", "/api/v1/datasets"):
        response = client.get(path, headers=headers)
        assert response.status_code == 403, path
        assert response.json()["error"]["code"] == "MEMBERSHIP_DISABLED"
    assert_matches_response("getMe", 403, client.get("/api/v1/me", headers=headers).json())


def test_unknown_org_is_rejected_without_provisioning(seeded: PgUrls) -> None:  # M01-AT-07
    token = ISSUER.token(sub="kc-stranger", email="stranger@elsewhere.local", org_code="unknown-org")
    response = make_client(seeded).get("/api/v1/me", headers=bearer(token))
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ORGANIZATION_UNKNOWN"
    assert_matches_response("getMe", 403, response.json())
    assert scalar(seeded, "SELECT count(*) FROM identity.users WHERE keycloak_sub = 'kc-stranger'") == 0


@pytest.mark.parametrize("kind", ["expired", "forged", "audience", "missing"])
def test_invalid_tokens_are_unauthenticated(seeded: PgUrls, kind: str) -> None:  # M01-AT-08
    tokens = {
        "expired": token_for(RESEARCHER, expires_in=-120),
        "forged": FakeIssuer().token(sub=USERS_BY_EMAIL[RESEARCHER].keycloak_sub, org_code="inst-a"),
        "audience": token_for(RESEARCHER, aud="some-other-api"),
        "missing": None,
    }
    token = tokens[kind]
    headers = bearer(token) if token else {}
    client = make_client(seeded, probe_module())
    for path in ("/api/v1/me", "/api/v1/projects"):
        response = client.get(path, headers=headers)
        assert response.status_code == 401, path
        assert response.json()["error"]["code"] == "UNAUTHENTICATED"
    assert_matches_response("getMe", 401, client.get("/api/v1/me", headers=headers).json())


def test_email_of_another_account_is_409(seeded: PgUrls) -> None:
    token = ISSUER.token(sub="kc-imposter", email="A.Researcher@inst-a.local", org_code="inst-a")
    response = make_client(seeded).get("/api/v1/me", headers=bearer(token))
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "CONFLICT"
    assert_matches_response("getMe", 409, response.json())
