from collections.abc import Sequence
from typing import Any
from uuid import UUID

from fastapi.testclient import TestClient

from api.modules.audit import MODULE
from api.modules.audit.fakes import ADMIN, SEED_USERS
from api.platform import ports
from api.platform.auth import CurrentUser, PrincipalResolver, TokenVerifier, get_token_verifier
from api.platform.modules import ModuleSpec
from api.platform.settings import Settings
from api.platform.testing.app import create_test_app
from api.platform.testing.fixtures import PgUrls
from api.platform.testing.tokens import FakeIssuer

ISSUER = FakeIssuer()
PRINCIPALS: dict[UUID, CurrentUser] = {
    u.user_id: CurrentUser(
        user_id=u.user_id,
        organization_id=u.organization_id,
        org_roles=u.org_roles,
        platform_roles=frozenset({"PLATFORM_ADMIN"}) if u.user_id == ADMIN else frozenset(),
        session_id=f"session-{u.user_id}",
        display_name=u.display_name,
    )
    for u in SEED_USERS
}


class SeedResolver:
    """Stands in for M01's PrincipalResolver: token sub = seed user id."""

    def resolve(self, claims: dict[str, Any], correlation_id: UUID) -> CurrentUser:
        return PRINCIPALS[UUID(claims["sub"])]


def make_client(urls: PgUrls, *, extra_modules: Sequence[ModuleSpec] = ()) -> TestClient:
    app = create_test_app(modules=[MODULE, *extra_modules], settings=Settings(database_url=urls.app))
    app.dependency_overrides[get_token_verifier] = lambda: TokenVerifier(
        issuer=ISSUER.issuer, audience=ISSUER.audience, jwk_client=ISSUER.jwk_client()
    )
    ports.provide(PrincipalResolver, SeedResolver())
    return TestClient(app)


def auth(user_id: UUID) -> dict[str, str]:
    return {"Authorization": f"Bearer {ISSUER.token(sub=str(user_id))}"}
