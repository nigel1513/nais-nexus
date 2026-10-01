"""Identity fixtures: schema migrated once per session, identity tables emptied before each test."""

from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine, text

from api.modules.identity import MODULE
from api.platform.migrate import upgrade_all
from api.platform.testing.fixtures import PgUrls

IDENTITY_TABLES = (
    "identity.user_sessions, identity.organization_memberships, identity.users, identity.organizations"
)


@pytest.fixture(scope="session")
def identity_db(migrated_db: PgUrls) -> PgUrls:
    upgrade_all(migrated_db.migrator, [MODULE])
    return migrated_db


@pytest.fixture
def db(identity_db: PgUrls) -> Iterator[PgUrls]:
    engine = create_engine(identity_db.migrator)
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {IDENTITY_TABLES}"))
        conn.execute(text("DELETE FROM platform.outbox_events WHERE event_type LIKE 'identity.%'"))
    engine.dispose()
    yield identity_db
