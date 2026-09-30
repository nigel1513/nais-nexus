import time
import uuid
from typing import Any

import jwt
import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from api.platform import ports
from api.platform.auth import (
    CurrentUser,
    CurrentUserDep,
    PrincipalResolver,
    TokenVerifier,
    get_token_verifier,
)
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.modules import ModuleSpec
from api.platform.testing.app import create_test_app
from api.platform.testing.tokens import FakeIssuer, forge_hs256

USER_ID = uuid.UUID("00000000-0000-7000-8000-000000000a02")
ORG_ID = uuid.UUID("00000000-0000-7000-8000-00000000000a")
ISSUER = FakeIssuer()


class FakeResolver:
    def __init__(self, error: ApiError | None = None) -> None:
        self.error = error

    def resolve(self, claims: dict[str, Any], correlation_id: uuid.UUID) -> CurrentUser:
        if self.error:
            raise self.error
        return CurrentUser(
            user_id=USER_ID,
            organization_id=ORG_ID,
            org_roles=frozenset({"DATA_STEWARD"}),
            session_id=claims["sid"],
            display_name=claims["name"],
        )


DEFAULT_RESOLVER = FakeResolver()


def make_client(
    *, jwk_fail: Exception | None = None, resolver: FakeResolver | None = DEFAULT_RESOLVER
) -> TestClient:
    router = APIRouter()

    @router.get("/whoami")
    def whoami(user: CurrentUserDep) -> dict[str, str]:
        return {"user_id": str(user.user_id), "session": user.session_id}

    app = create_test_app(modules=[ModuleSpec(name="probe", router=router)])
    app.dependency_overrides[get_token_verifier] = lambda: TokenVerifier(
        issuer=ISSUER.issuer, audience=ISSUER.audience, jwk_client=ISSUER.jwk_client(fail=jwk_fail)
    )
    if resolver is not None:
        ports.provide(PrincipalResolver, resolver)
    return TestClient(app)


def call(client: TestClient, token: str | None) -> Any:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return client.get("/api/v1/whoami", headers=headers)


def error_code(response: Any) -> str:
    return str(response.json()["error"]["code"])


def test_valid_token_resolves_current_user() -> None:
    response = call(make_client(), ISSUER.token())
    assert response.status_code == 200
    assert response.json() == {"user_id": str(USER_ID), "session": "session-1"}


def test_missing_token_is_401() -> None:
    response = call(make_client(), None)
    assert response.status_code == 401 and error_code(response) == "UNAUTHENTICATED"


@pytest.mark.parametrize(
    "claims",
    [{"expires_in": -120}, {"aud": "someone-else"}, {"iss": "http://evil.example/realms/nais"}],
    ids=["expired", "wrong-audience", "wrong-issuer"],
)
def test_invalid_claims_are_401(claims: dict[str, Any]) -> None:
    response = call(make_client(), ISSUER.token(**claims))
    assert response.status_code == 401 and error_code(response) == "UNAUTHENTICATED"


def test_alg_none_is_rejected() -> None:
    now = int(time.time())
    payload = {
        "iss": ISSUER.issuer,
        "aud": ISSUER.audience,
        "sub": "x",
        "iat": now,
        "exp": now + 300,
        "sid": "s",
    }
    token = jwt.encode(payload, None, algorithm="none", headers={"kid": ISSUER.kid})  # type: ignore[arg-type]
    assert call(make_client(), token).status_code == 401


def test_hs256_with_public_key_is_rejected() -> None:
    now = int(time.time())
    payload = {
        "iss": ISSUER.issuer,
        "aud": ISSUER.audience,
        "sub": "x",
        "iat": now,
        "exp": now + 300,
        "sid": "s",
    }
    token = forge_hs256(payload, ISSUER.public_pem(), ISSUER.kid)
    assert call(make_client(), token).status_code == 401


def test_resolver_errors_pass_through() -> None:
    response = call(make_client(resolver=FakeResolver(ApiError("USER_DISABLED"))), ISSUER.token())
    assert response.status_code == 403 and error_code(response) == "USER_DISABLED"


def test_missing_identity_module_is_503() -> None:
    response = call(make_client(resolver=None), ISSUER.token())
    assert response.status_code == 503 and error_code(response) == "DEPENDENCY_UNAVAILABLE"


def test_unreachable_jwks_is_503() -> None:
    response = call(make_client(jwk_fail=jwt.PyJWKClientConnectionError("down")), ISSUER.token())
    assert response.status_code == 503 and error_code(response) == "DEPENDENCY_UNAVAILABLE"


def test_current_user_helpers_and_event_actor() -> None:
    user = FakeResolver().resolve({"sid": "s", "name": "n"}, uuid.uuid4())
    assert user.has_org_role(ORG_ID, "DATA_STEWARD")
    assert not user.has_org_role(uuid.uuid4(), "DATA_STEWARD")
    assert not user.is_platform_admin
    assert EventActor.for_user(user) == EventActor(type="USER", user_id=USER_ID, organization_id=ORG_ID)
