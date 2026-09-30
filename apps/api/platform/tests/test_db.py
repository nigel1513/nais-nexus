import uuid
from collections.abc import Iterator

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from api.platform.db import SessionDep
from api.platform.modules import ModuleSpec
from api.platform.settings import Settings
from api.platform.testing.app import create_test_app
from api.platform.testing.fixtures import PgUrls


@pytest.fixture
def probe_table(migrated_db: PgUrls) -> Iterator[PgUrls]:
    engine = create_engine(migrated_db.migrator)
    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE autonomy.session_probe (id int NOT NULL, "
                "CONSTRAINT session_probe_id_key UNIQUE (id) DEFERRABLE INITIALLY DEFERRED)"
            )
        )
    try:
        yield migrated_db
    finally:
        with engine.begin() as conn:
            conn.execute(text("DROP TABLE autonomy.session_probe"))
        engine.dispose()


def make_client(urls: PgUrls) -> TestClient:
    router = APIRouter()

    @router.post("/probe/{count}")
    def insert(count: int, session: SessionDep) -> dict[str, int]:
        for _ in range(count):
            session.execute(text("INSERT INTO autonomy.session_probe (id) VALUES (1)"))
        return {"inserted": count}

    app = create_test_app(
        modules=[ModuleSpec(name="probe", router=router)], settings=Settings(database_url=urls.app)
    )
    return TestClient(app, raise_server_exceptions=False)


def rows(urls: PgUrls) -> int:
    engine = create_engine(urls.migrator)
    with engine.connect() as conn:
        count = conn.execute(text("SELECT count(*) FROM autonomy.session_probe")).scalar_one()
    engine.dispose()
    return int(count)


def test_session_dep_commits_before_the_response(probe_table: PgUrls) -> None:
    response = make_client(probe_table).post("/api/v1/probe/1")
    assert response.status_code == 200
    assert rows(probe_table) == 1


def test_commit_failure_returns_500_envelope_not_2xx(probe_table: PgUrls) -> None:
    rid = "0192f0c0-0000-7000-8000-0000000000ee"
    response = make_client(probe_table).post("/api/v1/probe/2", headers={"X-Request-Id": rid})
    assert response.status_code == 500
    assert response.json()["error"] == {
        "code": "INTERNAL_ERROR",
        "message": "Unexpected server error.",
        "trace_id": uuid.UUID(rid).hex,
    }
    assert rows(probe_table) == 0
