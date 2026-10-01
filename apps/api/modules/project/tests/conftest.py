from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine, text

from api.modules.project import MODULE
from api.platform.migrate import upgrade_all
from api.platform.testing.fixtures import PgUrls


@pytest.fixture(scope="session")
def project_db(migrated_db: PgUrls) -> PgUrls:
    """Platform + project migrations applied once per test session."""
    upgrade_all(migrated_db.migrator, [MODULE])
    return migrated_db


@pytest.fixture
def db(project_db: PgUrls) -> Iterator[PgUrls]:
    """Empty project tables and outbox for every test."""
    engine = create_engine(project_db.migrator)
    with engine.begin() as conn:
        conn.execute(
            text("TRUNCATE project.project_members, project.project_organizations, project.projects")
        )
        conn.execute(text("DELETE FROM platform.outbox_events"))
    engine.dispose()
    yield project_db
