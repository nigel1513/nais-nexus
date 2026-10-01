"""Live checks against the running compose stack through the 21051 gateway.

Opt-in: NAIS_LIVE=1 uv run pytest apps/api/modules/identity/tests/test_live_stack.py -v
"""

import base64
import json
import os
from typing import Any

import httpx
import pytest

from api.modules.identity.seed_data import USERS
from api.platform.settings import REPO_ROOT

pytestmark = pytest.mark.skipif(os.environ.get("NAIS_LIVE") != "1", reason="set NAIS_LIVE=1 to hit the stack")

BASE = os.environ.get("NAIS_LIVE_BASE_URL", "http://localhost:21051")
REALM = f"{BASE}/auth/realms/nais"
CALLBACK = "http://localhost:21051/web-auth/callback/keycloak"
PKCE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"


def env_value(key: str, default: str) -> str:
    if key in os.environ:
        return os.environ[key]
    env_file = REPO_ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1].strip()
    return default


EXPECTED_ISSUER = env_value("OIDC_ISSUER", "http://localhost:21051/auth/realms/nais")


def password_token(
    username: str, *, password: str = "nais", client_id: str = "nais-e2e", secret: str | None = "nais"
) -> httpx.Response:
    data = {
        "grant_type": "password",
        "client_id": client_id,
        "username": username,
        "password": password,
        "scope": "openid",
    }
    if secret is not None:
        data["client_secret"] = secret
    return httpx.post(f"{REALM}/protocol/openid-connect/token", data=data, timeout=10)


def access_token(username: str) -> str:
    response = password_token(username)
    assert response.status_code == 200, response.text
    return str(response.json()["access_token"])


def claims_of(token: str) -> dict[str, Any]:
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    claims: dict[str, Any] = json.loads(base64.urlsafe_b64decode(payload))
    return claims


def authorize(**extra: str) -> httpx.Response:
    params = {"client_id": "nais-web", "response_type": "code", "scope": "openid", "redirect_uri": CALLBACK}
    params.update(extra)
    return httpx.get(
        f"{REALM}/protocol/openid-connect/auth", params=params, timeout=10, follow_redirects=False
    )


def test_discovery_document() -> None:
    response = httpx.get(f"{REALM}/.well-known/openid-configuration", timeout=10)
    assert response.status_code == 200
    document = response.json()
    assert document["issuer"] == EXPECTED_ISSUER
    assert "S256" in document["code_challenge_methods_supported"]


def test_password_grant_token_carries_nais_claims() -> None:
    claims = claims_of(access_token("a.researcher@inst-a.local"))
    assert claims["iss"] == EXPECTED_ISSUER
    audience = claims["aud"] if isinstance(claims["aud"], list) else [claims["aud"]]
    assert "nais-api" in audience
    assert claims["sub"] == "00000000-0000-7000-8000-000000000a02"
    assert claims["org_code"] == "inst-a"
    assert claims["email"] == "a.researcher@inst-a.local"
    assert claims["name"] == "A Researcher"
    assert claims["sid"]
    assert claims["exp"] - claims["iat"] == 300


def test_every_seed_user_can_log_in() -> None:
    for user in USERS:
        assert password_token(user.email).status_code == 200, user.email


def test_wrong_password_is_rejected() -> None:
    assert password_token("a.researcher@inst-a.local", password="wrong").status_code == 401


def test_web_client_has_no_direct_grant() -> None:
    response = password_token("a.researcher@inst-a.local", client_id="nais-web", secret=None)
    assert response.status_code in (400, 401)
    assert response.json()["error"] == "unauthorized_client"


def test_authorization_code_without_pkce_is_rejected() -> None:  # M01-AT-16
    rejected = authorize()
    assert rejected.status_code == 302
    location = rejected.headers["location"]
    assert location.startswith(CALLBACK)
    assert "error=invalid_request" in location and "code_challenge_method" in location
    accepted = authorize(code_challenge=PKCE_CHALLENGE, code_challenge_method="S256")
    assert accepted.status_code == 200  # the login page


API = f"{BASE}/api/v1"


def api_get(path: str, token: str | None, **params: Any) -> httpx.Response:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return httpx.get(f"{API}{path}", params=params, headers=headers, timeout=10)


def test_me_through_gateway_for_each_institute() -> None:  # M01-AT-01
    from api.platform.testing.contracts import assert_matches_response

    for email, code in (("a.researcher@inst-a.local", "inst-a"), ("b.researcher@inst-b.local", "inst-b")):
        response = api_get("/me", access_token(email))
        assert response.status_code == 200, response.text
        assert_matches_response("getMe", 200, response.json())
        assert response.json()["organization"]["code"] == code


def test_platform_admin_through_gateway() -> None:
    body = api_get("/me", access_token("admin@nais.local")).json()
    assert body["platform_roles"] == ["PLATFORM_ADMIN"] and body["organization"]["code"] == "nais"


def test_disabled_member_logs_in_but_is_blocked() -> (
    None
):  # M01-AT-05 (/projects, /datasets arrive with M02/M03)
    response = api_get("/me", access_token("b.disabled@inst-b.local"))
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "MEMBERSHIP_DISABLED"


def test_bad_tokens_are_401_through_gateway() -> None:  # M01-AT-08
    token = access_token("a.researcher@inst-a.local")
    header, payload, signature = token.split(".")
    tampered = f"{header}.{payload}.{signature[:-4]}AAAA"
    for candidate in (tampered, None):
        response = api_get("/me", candidate)
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "UNAUTHENTICATED"


def test_directory_through_gateway() -> None:  # M01-AT-14
    body = api_get("/users", access_token("a.researcher@inst-a.local"), q="b.").json()
    assert [item["display_name"] for item in body["items"]] == ["B Admin", "B Researcher", "B Steward"]
    assert all("email" not in item for item in body["items"])
