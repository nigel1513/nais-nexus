import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError

from api.modules.project.seed_data import ORG_A, USERS_BY_KEY
from api.platform.db import session_scope
from api.platform.testing.fixtures import PgUrls

OWNER = USERS_BY_KEY["a.researcher"].user_id


def _insert_project(urls: PgUrls, **extra: object) -> uuid.UUID:
    project_id = uuid.uuid4()
    columns = ", ".join(["project_id", "name", "lead_organization_id", "created_by", *extra])
    values = ", ".join([":project_id", ":name", ":org", ":user", *(f":{key}" for key in extra)])
    with session_scope(urls.app) as session:
        session.execute(
            text(f"INSERT INTO project.projects ({columns}) VALUES ({values})"),
            {"project_id": project_id, "name": "Study", "org": ORG_A, "user": OWNER, **extra},
        )
    return project_id


def _insert_member(urls: PgUrls, project_id: uuid.UUID, status: str) -> None:
    with session_scope(urls.app) as session:
        session.execute(
            text(
                "INSERT INTO project.project_members "
                "(project_member_id, project_id, user_id, organization_id, role, status, added_by) "
                "VALUES (:id, :project_id, :user, :org, 'VIEWER', :status, :user)"
            ),
            {"id": uuid.uuid4(), "project_id": project_id, "user": OWNER, "org": ORG_A, "status": status},
        )


def test_tables_and_indexes_exist(project_db: PgUrls) -> None:
    engine = create_engine(project_db.migrator)
    with engine.connect() as conn:
        tables = set(
            conn.execute(
                text("SELECT table_name FROM information_schema.tables WHERE table_schema = 'project'")
            ).scalars()
        )
        indexes = set(
            conn.execute(text("SELECT indexname FROM pg_indexes WHERE schemaname = 'project'")).scalars()
        )
    engine.dispose()
    assert {"projects", "project_members", "project_organizations", "alembic_version"} <= tables
    assert {
        "ix_projects_visibility_status",
        "ix_projects_name_trgm",
        "ux_project_members_active",
        "ix_project_members_user",
    } <= indexes


def test_column_defaults(db: PgUrls) -> None:
    project_id = _insert_project(db)
    with session_scope(db.app) as session:
        row = (
            session.execute(
                text(
                    "SELECT description, visibility, status, keywords FROM project.projects WHERE project_id = :id"
                ),
                {"id": project_id},
            )
            .mappings()
            .one()
        )
    assert dict(row) == {"description": "", "visibility": "PRIVATE", "status": "ACTIVE", "keywords": []}


def test_end_date_before_start_date_is_rejected(db: PgUrls) -> None:
    with pytest.raises(IntegrityError):
        _insert_project(db, start_date="2026-10-02", end_date="2026-10-01")


def test_one_active_membership_per_user(db: PgUrls) -> None:
    project_id = _insert_project(db)
    _insert_member(db, project_id, "REMOVED")
    _insert_member(db, project_id, "ACTIVE")  # a REMOVED history row does not block a new ACTIVE row
    with pytest.raises(IntegrityError):
        _insert_member(db, project_id, "ACTIVE")
