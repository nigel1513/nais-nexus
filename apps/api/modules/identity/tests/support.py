"""Shared helpers for identity tests. Import as api.modules.identity.tests.support."""

from typing import Any

from sqlalchemy import text

from api.platform.db import session_factory
from api.platform.testing.fixtures import PgUrls


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
