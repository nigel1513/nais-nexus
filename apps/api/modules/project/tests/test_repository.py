import uuid
from datetime import UTC, date, datetime, timedelta

import pytest
from pydantic import ValidationError
from sqlalchemy.orm import Session

from api.modules.project import repository as repo
from api.modules.project.schemas import MemberAddIn, ProjectCreateIn, ProjectUpdateIn
from api.modules.project.seed_data import ORG_A, ORG_B, USERS_BY_KEY
from api.platform.db import session_scope
from api.platform.testing.fixtures import PgUrls

A = USERS_BY_KEY["a.researcher"]
B = USERS_BY_KEY["b.researcher"]
B2 = USERS_BY_KEY["b.steward"]
T0 = datetime(2026, 10, 1, tzinfo=UTC)


def _project(
    session: Session, *, name: str = "Study", visibility: str = "PRIVATE", now: datetime = T0
) -> uuid.UUID:
    project_id = uuid.uuid4()
    repo.insert_project(
        session,
        project_id=project_id,
        name=name,
        description="",
        visibility=visibility,
        lead_organization_id=ORG_A,
        keywords=[],
        start_date=None,
        end_date=None,
        created_by=A.user_id,
        now=now,
    )
    repo.insert_member(
        session,
        project_id=project_id,
        user_id=A.user_id,
        organization_id=ORG_A,
        role="PROJECT_OWNER",
        added_by=A.user_id,
        now=now,
    )
    repo.add_org_member(session, project_id, ORG_A, lead=True)
    return project_id


def test_create_schema_trims_and_defaults() -> None:
    body = ProjectCreateIn.model_validate({"name": "  ab  ", "description": ""})
    assert body.name == "ab"
    assert body.visibility == "PRIVATE"
    assert body.keywords == []
    with pytest.raises(ValidationError):
        ProjectCreateIn.model_validate({"name": "   ", "description": ""})
    with pytest.raises(ValidationError):
        ProjectCreateIn.model_validate({"name": "ok name", "description": "", "extra": 1})
    with pytest.raises(ValidationError):
        ProjectCreateIn.model_validate({"name": "ok name", "description": "", "keywords": ["k"] * 21})
    with pytest.raises(ValidationError):
        ProjectCreateIn.model_validate({"name": "ok name", "description": "", "keywords": ["x" * 51]})


def test_update_schema_rejects_empty_and_nulls_but_allows_null_dates() -> None:
    with pytest.raises(ValidationError):
        ProjectUpdateIn.model_validate({})
    for field in ("name", "description", "visibility", "keywords"):
        with pytest.raises(ValidationError):
            ProjectUpdateIn.model_validate({field: None})
    patch = ProjectUpdateIn.model_validate({"start_date": None})
    assert patch.model_dump(exclude_unset=True) == {"start_date": None}


def test_member_schema_rejects_unknown_role() -> None:
    with pytest.raises(ValidationError):
        MemberAddIn.model_validate({"user_id": str(uuid.uuid4()), "role": "OWNER"})


def test_organization_counts_follow_members(db: PgUrls) -> None:
    with session_scope(db.app) as session:
        project_id = _project(session)
        repo.add_org_member(session, project_id, ORG_B)
        repo.add_org_member(session, project_id, ORG_B)
        repo.add_org_member(session, project_id, ORG_A)
        counts = {
            r["organization_id"]: (r["role"], r["active_member_count"])
            for r in repo.list_organizations(session, project_id)
        }
        assert counts == {ORG_A: ("LEAD", 2), ORG_B: ("PARTNER", 2)}
        repo.drop_org_member(session, project_id, ORG_B)
        repo.drop_org_member(session, project_id, ORG_B)
        repo.drop_org_member(session, project_id, ORG_A)
        repo.drop_org_member(session, project_id, ORG_A)
        rows = repo.list_organizations(session, project_id)
        assert [(r["organization_id"], r["role"], r["active_member_count"]) for r in rows] == [
            (ORG_A, "LEAD", 0)
        ]


def test_membership_queries(db: PgUrls) -> None:
    with session_scope(db.app) as session:
        project_id = _project(session)
        member = repo.insert_member(
            session,
            project_id=project_id,
            user_id=B.user_id,
            organization_id=ORG_B,
            role="RESEARCHER",
            added_by=A.user_id,
            now=T0,
        )
        assert repo.member_role(session, project_id, B.user_id) == "RESEARCHER"
        assert repo.count_active_members(session, project_id) == 2
        assert repo.count_active_owners(session, project_id) == 1
        assert repo.set_member_role(session, member["project_member_id"], "VIEWER")["role"] == "VIEWER"
        assert repo.is_active_member(session, project_id, B.user_id)
        assert repo.project_ids_for_member(session, B.user_id) == [project_id]
        repo.remove_member(session, member["project_member_id"], removed_by=A.user_id, now=T0)
        assert repo.member_role(session, project_id, B.user_id) is None
        assert repo.active_member(session, project_id, B.user_id) is None
        assert [m["user_id"] for m in repo.list_active_members(session, project_id)] == [A.user_id]
        assert repo.member_counts(session, [project_id]) == {project_id: 1}
        assert repo.roles_for_user(session, [project_id], A.user_id) == {project_id: "PROJECT_OWNER"}
        repo.archive_project(session, project_id, now=T0)
        assert not repo.is_active_member(session, project_id, A.user_id)
        assert repo.member_role(session, project_id, A.user_id) == "PROJECT_OWNER"


def test_list_projects_scopes_filters_and_keyset(db: PgUrls) -> None:
    with session_scope(db.app) as session:
        older = _project(session, name="Older Study", visibility="PUBLIC", now=T0)
        newer = _project(session, name="Newer Study", now=T0 + timedelta(minutes=1))
        repo.update_project(session, newer, {"start_date": date(2026, 1, 1)}, now=T0 + timedelta(minutes=2))
        mine = repo.list_projects(
            session, user_id=A.user_id, scope="mine", status=None, q=None, after=None, limit=10
        )
        assert [r["project_id"] for r in mine] == [newer, older]
        discover = repo.list_projects(
            session, user_id=B.user_id, scope="discover", status=None, q=None, after=None, limit=10
        )
        assert [r["project_id"] for r in discover] == [older]
        assert (
            repo.list_projects(
                session, user_id=B.user_id, scope="mine", status=None, q=None, after=None, limit=10
            )
            == []
        )
        by_name = repo.list_projects(
            session, user_id=A.user_id, scope="mine", status=None, q="older", after=None, limit=10
        )
        assert [r["project_id"] for r in by_name] == [older]
        first = mine[0]
        after = repo.list_projects(
            session,
            user_id=A.user_id,
            scope="mine",
            status=None,
            q=None,
            after=(first["updated_at"], first["project_id"]),
            limit=10,
        )
        assert [r["project_id"] for r in after] == [older]
        assert (
            repo.list_projects(
                session, user_id=B2.user_id, scope="mine", status=None, q=None, after=None, limit=10
            )
            == []
        )
