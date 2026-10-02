from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine, text

from api.modules.catalog import MODULE
from api.platform.migrate import upgrade_all
from api.platform.testing.fixtures import PgUrls

TRUNCATE = (
    "catalog.file_previews",
    "catalog.dataset_contributors",
    "catalog.dataset_files",
    "catalog.upload_sessions",
    "catalog.dataset_versions",
    "catalog.datasets",
    "catalog.readiness_summaries",
    "catalog.index_queue",
    "catalog.processed_events",
    "platform.outbox_events",
)


@pytest.fixture(scope="session")
def catalog_db(migrated_db: PgUrls) -> PgUrls:
    upgrade_all(migrated_db.migrator, [MODULE])
    return migrated_db


@pytest.fixture
def db(catalog_db: PgUrls) -> Iterator[PgUrls]:
    """Empty catalog tables + outbox. TRUNCATE (as owner) bypasses the row-level immutability triggers."""
    engine = create_engine(catalog_db.migrator)
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {', '.join(TRUNCATE)} CASCADE"))
        # Seeded vocabulary terms are all active; undo any deactivation a previous test left behind.
        conn.execute(text("UPDATE catalog.vocabulary_terms SET active = true WHERE NOT active"))
    engine.dispose()
    yield catalog_db
