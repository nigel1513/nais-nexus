"""Readiness test fixtures: the module's schema migrated on the platform's throwaway Postgres."""

from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine, text

from api.modules.readiness import MODULE
from api.platform.migrate import upgrade_all
from api.platform.testing.fixtures import PgUrls


@pytest.fixture(scope="session")
def readiness_db(migrated_db: PgUrls) -> PgUrls:
    upgrade_all(migrated_db.migrator, [MODULE])
    return migrated_db


@pytest.fixture
def db(readiness_db: PgUrls) -> Iterator[PgUrls]:
    """Empty readiness tables + outbox per test."""
    engine = create_engine(readiness_db.migrator)
    with engine.begin() as conn:
        conn.execute(
            text(
                "TRUNCATE readiness.check_results, readiness.validations, readiness.processed_events, "
                "platform.outbox_events"
            )
        )
    engine.dispose()
    yield readiness_db
