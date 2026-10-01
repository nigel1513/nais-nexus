"""Shared helpers for identity tests. Import as api.modules.identity.tests.support."""

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import text

from api.platform.db import session_factory
from api.platform.modules import ModuleSpec
from api.platform.testing.fixtures import PgUrls
from api.platform.testing.tokens import FakeIssuer


def scalar(urls: PgUrls, sql: str, **params: Any) -> Any:
    with session_factory(urls.app)() as session:
        return session.execute(text(sql), params).scalar_one()


def events(urls: PgUrls, event_type: str, **payload_match: str) -> list[dict[str, Any]]:
    """Outbox envelopes of one event type (oldest first) whose payload has every given key/value."""
    with session_factory(urls.app)() as session:
        rows = session.execute(
            text("SELECT envelope FROM platform.outbox_events WHERE event_type = :t ORDER BY id"),
            {"t": event_type},
        ).scalars()
        envelopes = [dict(row) for row in rows]
    return [
        env
        for env in envelopes
        if all(env["payload"].get(key) == value for key, value in payload_match.items())
    ]


def seed_all(urls: PgUrls) -> None:
    from api.modules.identity.seed import seed
    from api.platform.db import session_scope

    with session_scope(urls.app) as session:
        seed(session)


def claims_for(email: str, *, sid: str | None = "s-1", **overrides: Any) -> dict[str, Any]:
    """Verified-token claims for a seed user, as the platform hands them to the resolver."""
    import time

    from api.modules.identity.seed_data import USERS_BY_EMAIL

    user = USERS_BY_EMAIL[email]
    claims: dict[str, Any] = {
        "sub": user.keycloak_sub,
        "email": user.email,
        "name": user.display_name,
        "org_code": user.org_code,
        "iat": int(time.time()),
    }
    if sid is not None:
        claims["sid"] = sid
    claims.update(overrides)
    return claims


ISSUER = FakeIssuer()


def make_client(urls: PgUrls, *extra: ModuleSpec) -> TestClient:
    """Test app with identity (+ extra probe modules), fake JWKS, and identity ports bound to the test DB."""
    from api.modules.identity import MODULE, wire_ports
    from api.platform.auth import TokenVerifier, get_token_verifier
    from api.platform.db import session_scope
    from api.platform.settings import Settings
    from api.platform.testing.app import create_test_app

    app = create_test_app(modules=[MODULE, *extra], settings=Settings(database_url=urls.app))
    app.dependency_overrides[get_token_verifier] = lambda: TokenVerifier(
        issuer=ISSUER.issuer, audience=ISSUER.audience, jwk_client=ISSUER.jwk_client()
    )
    # create_test_app ran MODULE.wire() against the default DATABASE_URL; rebind to the test database.
    wire_ports(lambda: session_scope(urls.app))
    return TestClient(app, raise_server_exceptions=False)


def token_for(email: str, *, sid: str = "s-1", **claims: Any) -> str:
    from api.modules.identity.seed_data import USERS_BY_EMAIL

    user = USERS_BY_EMAIL[email]
    base: dict[str, Any] = {
        "sub": user.keycloak_sub,
        "email": user.email,
        "name": user.display_name,
        "org_code": user.org_code,
        "sid": sid,
    }
    base.update(claims)
    return ISSUER.token(**base)


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}
