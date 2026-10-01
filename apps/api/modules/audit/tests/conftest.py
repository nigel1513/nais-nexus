from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine, text

from api.modules.audit import MODULE
from api.modules.audit.fakes import provide_seed_ports
from api.modules.audit.settings import get_audit_settings
from api.platform.migrate import upgrade_all
from api.platform.testing.fixtures import PgUrls


@pytest.fixture(scope="session")
def audit_db(migrated_db: PgUrls) -> PgUrls:
    upgrade_all(migrated_db.migrator, [MODULE])
    return migrated_db


def wipe(urls: PgUrls) -> None:
    """Superuser-only cleanup: temporarily disables the append-only triggers (tests only)."""
    engine = create_engine(urls.superuser)
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE audit.audit_events DISABLE TRIGGER USER"))
        conn.execute(
            text(
                "TRUNCATE audit.audit_events, audit.email_deliveries, audit.notifications, "
                "audit.processed_events"
            )
        )
        conn.execute(text("ALTER TABLE audit.audit_events ENABLE TRIGGER USER"))
        conn.execute(text("DELETE FROM platform.outbox_events"))
    engine.dispose()


@pytest.fixture
def db(audit_db: PgUrls) -> Iterator[PgUrls]:
    wipe(audit_db)
    yield audit_db


@pytest.fixture(autouse=True)
def _fresh_audit_settings() -> Iterator[None]:
    get_audit_settings.cache_clear()
    yield
    get_audit_settings.cache_clear()


@pytest.fixture(autouse=True)
def seed_ports() -> None:
    """Every test starts with the seed fakes provided; the platform's autouse fixture resets ports after."""
    provide_seed_ports()
