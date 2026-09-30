"""Shared pytest fixtures for platform and module tests (registered from the root conftest.py)."""

from collections.abc import Iterator
from dataclasses import dataclass

import pytest
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url

from api.platform import ports
from api.platform.settings import REPO_ROOT

INIT_SQL = REPO_ROOT / "infra" / "docker" / "postgres" / "init.sql"


@pytest.fixture(autouse=True)
def _reset_ports() -> Iterator[None]:
    yield
    ports.reset()


@dataclass(frozen=True)
class PgUrls:
    superuser: str
    migrator: str
    app: str


def _as_role(url: str, role: str) -> str:
    return make_url(url).set(username=role, password="nais").render_as_string(hide_password=False)


@pytest.fixture(scope="session")
def pg_urls() -> Iterator[PgUrls]:
    """Throwaway postgres:16 with the same roles/schemas as compose. Skips when Docker is unavailable."""
    from testcontainers.community.postgres import PostgresContainer

    container = PostgresContainer(
        "postgres:16", username="postgres", password="postgres", dbname="nais", driver="psycopg"
    )
    try:
        container.start()
    except Exception as exc:  # docker missing or daemon not reachable
        pytest.skip(f"PostgreSQL container unavailable: {exc}")
    try:
        superuser = container.get_connection_url()
        engine = create_engine(superuser)
        with engine.begin() as conn:
            # psycopg's raw cursor with no params leaves the script's format() "%I" placeholders alone
            conn.connection.cursor().execute(INIT_SQL.read_text(encoding="utf-8"))
        engine.dispose()
        yield PgUrls(
            superuser=superuser,
            migrator=_as_role(superuser, "nais_migrator"),
            app=_as_role(superuser, "nais_app"),
        )
    finally:
        container.stop()


@pytest.fixture(scope="session")
def migrated_db(pg_urls: PgUrls) -> PgUrls:
    from api.platform.migrate import upgrade_all

    upgrade_all(pg_urls.migrator, [])
    return pg_urls
