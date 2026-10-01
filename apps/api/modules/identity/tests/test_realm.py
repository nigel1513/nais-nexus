import json
from typing import Any

from api.modules.identity.seed_data import ORGS_BY_CODE, USERS
from api.platform.settings import REPO_ROOT

REALM_FILE = REPO_ROOT / "infra" / "keycloak" / "import" / "realm-nais.json"


def realm() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(REALM_FILE.read_text(encoding="utf-8"))
    return data


def client(client_id: str) -> dict[str, Any]:
    return next(c for c in realm()["clients"] if c["clientId"] == client_id)


def test_realm_basics() -> None:
    data = realm()
    assert data["realm"] == "nais" and data["enabled"] is True
    assert data["registrationAllowed"] is False
    assert (data["accessTokenLifespan"], data["ssoSessionIdleTimeout"], data["ssoSessionMaxLifespan"]) == (
        300,
        1800,
        36000,
    )
    assert "roles" not in data  # D-019: roles live in NAIS, not Keycloak


def test_nais_web_is_public_pkce_without_direct_grants() -> None:
    web = client("nais-web")
    assert web["publicClient"] is True
    assert web["standardFlowEnabled"] is True
    assert web["implicitFlowEnabled"] is False
    assert web["directAccessGrantsEnabled"] is False
    assert web["attributes"]["pkce.code.challenge.method"] == "S256"
    assert "http://localhost:21051/web-auth/callback/keycloak" in web["redirectUris"]
    assert "http://<NAIS_EXTERNAL_HOST>:21051/web-auth/callback/keycloak" in web["redirectUris"]
    # M10 (W1-D6): post-logout redirect to "/" on both hosts
    assert (
        web["attributes"]["post.logout.redirect.uris"]
        == "http://localhost:21051/*##http://<NAIS_EXTERNAL_HOST>:21051/*"
    )
    assert all(uri.endswith("/web-auth/callback/keycloak") for uri in web["redirectUris"])
    assert "http://localhost:21051" in web["webOrigins"]
    assert "basic" in web["defaultClientScopes"]  # KC 25+: the sub claim comes from the basic scope


def test_nais_api_is_audience_only() -> None:
    api = client("nais-api")
    assert api["bearerOnly"] is True
    assert api["standardFlowEnabled"] is False and api["directAccessGrantsEnabled"] is False


def test_e2e_client_is_confidential_with_direct_grants() -> None:
    e2e = client("nais-e2e")
    assert e2e["publicClient"] is False
    assert e2e["directAccessGrantsEnabled"] is True
    assert e2e["standardFlowEnabled"] is False
    assert e2e["secret"] == "nais"


def test_token_clients_emit_org_code_and_api_audience() -> None:
    for client_id in ("nais-web", "nais-e2e"):
        mappers = {m["name"]: m for m in client(client_id)["protocolMappers"]}
        org_code = mappers["org_code"]
        assert org_code["protocolMapper"] == "oidc-usermodel-attribute-mapper"
        assert org_code["config"]["user.attribute"] == "org_code"
        assert org_code["config"]["claim.name"] == "org_code"
        assert org_code["config"]["access.token.claim"] == "true"
        assert org_code["config"]["id.token.claim"] == "true"
        audience = mappers["audience-nais-api"]
        assert audience["protocolMapper"] == "oidc-audience-mapper"
        assert audience["config"]["included.client.audience"] == "nais-api"
        assert audience["config"]["access.token.claim"] == "true"


def test_org_code_is_required_and_admin_editable_only() -> None:
    component = realm()["components"]["org.keycloak.userprofile.UserProfileProvider"][0]
    profile = json.loads(component["config"]["kc.user.profile.config"][0])
    attribute = next(a for a in profile["attributes"] if a["name"] == "org_code")
    assert attribute["permissions"]["edit"] == ["admin"]
    assert "user" in attribute["required"]["roles"]
    assert {a["name"] for a in profile["attributes"]} >= {"username", "email", "firstName", "lastName"}


def test_realm_users_match_the_seed() -> None:
    by_id = {u["id"]: u for u in realm()["users"]}
    assert set(by_id) == {str(user.user_id) for user in USERS}
    for user in USERS:
        kc = by_id[str(user.user_id)]
        assert kc["username"] == kc["email"] == user.email
        assert kc["emailVerified"] is True and kc["enabled"] is True
        assert kc["attributes"]["org_code"] == [user.org_code]
        assert user.org_code in ORGS_BY_CODE
        assert f"{kc['firstName']} {kc['lastName']}" == user.display_name
        assert kc["credentials"] == [{"type": "password", "value": "nais", "temporary": False}]
        assert kc["requiredActions"] == []


def test_realm_user_ids_match_seed_ids_json() -> None:
    seed_ids = json.loads((REPO_ROOT / "infra" / "keycloak" / "seed_ids.json").read_text(encoding="utf-8"))
    assert {u["username"]: u["id"] for u in realm()["users"]} == seed_ids["users"]


def test_access_tokens_keep_sid_claim() -> None:
    # The resolver keys login sessions on `sid`: lightweight access tokens would drop it.
    data = realm()
    assert data.get("attributes", {}).get("client.use.lightweight.access.token.enabled") != "true"
    for c in data["clients"]:
        assert c.get("attributes", {}).get("client.use.lightweight.access.token.enabled") != "true"
        assert "basic" in c.get("defaultClientScopes", ["basic"])
