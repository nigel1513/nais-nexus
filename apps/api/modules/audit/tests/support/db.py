from typing import Any

from sqlalchemy import RowMapping, text

from api.platform.db import session_factory
from api.platform.event_bus import Handler
from api.platform.events import EventEnvelope
from api.platform.testing.fixtures import PgUrls


def run(urls: PgUrls, handler: Handler, event: EventEnvelope) -> None:
    """Run a handler the way the relay does: own session + transaction, as nais_app."""
    with session_factory(urls.app)() as session, session.begin():
        handler(session, event)


def scalar(urls: PgUrls, sql: str, **params: Any) -> Any:
    with session_factory(urls.app)() as session:
        return session.execute(text(sql), params).scalar_one()


def fetch(urls: PgUrls, sql: str, **params: Any) -> list[RowMapping]:
    with session_factory(urls.app)() as session:
        return list(session.execute(text(sql), params).mappings().all())
