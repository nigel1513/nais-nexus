from fastapi import FastAPI

from api.modules.project.seed_data import ORG_A, ORG_B
from api.modules.project.settings import ProjectSettings, get_project_settings
from api.modules.project.tests.helpers import ProjectApi, assert_error, project_events, seed_member, uid
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


def _add(api: ProjectApi, project_id: str, key: str, role: str, by: str = "a.researcher"):  # type: ignore[no-untyped-def]
    return api.post(by, f"/projects/{project_id}/members", json={"user_id": uid(key), "role": role})


def test_at02_owner_adds_partner_institute_researcher(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project(name="Battery Study")
    response = _add(api, project["project_id"], "b.researcher", "RESEARCHER")
    assert response.status_code == 201, response.text
    member = response.json()
    assert_matches_response("addProjectMember", 201, member)
    assert member["user_id"] == uid("b.researcher")
    assert member["organization_id"] == str(ORG_B)
    assert member["display_name"] == "B Researcher"
    assert member["organization_name"] == "Institute B"
    assert member["role"] == "RESEARCHER"
    assert member["added_by"] == uid("a.researcher")

    detail = api.get("a.researcher", f"/projects/{project['project_id']}").json()
    assert detail["member_count"] == 2
    assert [(o["organization_id"], o["role"]) for o in detail["organizations"]] == [
        (str(ORG_A), "LEAD"),
        (str(ORG_B), "PARTNER"),
    ]

    added = project_events(db)[-1]
    assert added["event_type"] == "project.member.added.v1"
    assert added["payload"] == {
        "project_id": project["project_id"],
        "project_name": "Battery Study",
        "user_id": uid("b.researcher"),
        "organization_id": str(ORG_B),
        "role": "RESEARCHER",
        "added_by": uid("a.researcher"),
    }


def test_at03_added_member_sees_project_with_role(api: ProjectApi) -> None:
    project = api.create_project()
    _add(api, project["project_id"], "b.researcher", "RESEARCHER")
    response = api.get("b.researcher", f"/projects/{project['project_id']}")
    assert response.status_code == 200
    assert response.json()["my_role"] == "RESEARCHER"
    mine = api.get("b.researcher", "/projects").json()["items"]
    assert [(i["project_id"], i["my_role"]) for i in mine] == [(project["project_id"], "RESEARCHER")]


def test_same_institute_member_creates_no_partner_row(api: ProjectApi) -> None:
    project = api.create_project()
    assert _add(api, project["project_id"], "a.steward", "VIEWER").status_code == 201
    detail = api.get("a.researcher", f"/projects/{project['project_id']}").json()
    assert detail["organizations"] == [{"organization_id": str(ORG_A), "name": "Institute A", "role": "LEAD"}]


def test_list_members_for_members_and_platform_admin(api: ProjectApi) -> None:
    project = api.create_project(visibility="PUBLIC")
    _add(api, project["project_id"], "b.researcher", "VIEWER")
    for user in ("a.researcher", "b.researcher", "admin"):
        response = api.get(user, f"/projects/{project['project_id']}/members")
        assert response.status_code == 200, user
        body = response.json()
        assert_matches_response("listProjectMembers", 200, body)
        assert [(m["display_name"], m["role"]) for m in body["items"]] == [
            ("A Researcher", "PROJECT_OWNER"),
            ("B Researcher", "VIEWER"),
        ]


def test_list_members_is_404_for_non_member_even_if_public(api: ProjectApi) -> None:
    project = api.create_project(visibility="PUBLIC")
    response = api.get("b.steward", f"/projects/{project['project_id']}/members")
    assert_error(response, 404, "NOT_FOUND", "listProjectMembers")


def test_at09_researcher_cannot_add(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    response = _add(api, project["project_id"], "b.steward", "VIEWER", by="b.researcher")
    assert_error(response, 403, "FORBIDDEN", "addProjectMember")


def test_admin_adds_only_researcher_or_viewer(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "a.admin", "PROJECT_ADMIN")
    assert _add(api, project["project_id"], "b.researcher", "RESEARCHER", by="a.admin").status_code == 201
    for role in ("PROJECT_ADMIN", "PROJECT_OWNER"):
        assert_error(
            _add(api, project["project_id"], "b.steward", role, by="a.admin"),
            403,
            "FORBIDDEN",
            "addProjectMember",
        )


def test_at10_existing_member_is_409(api: ProjectApi) -> None:
    project = api.create_project()
    _add(api, project["project_id"], "b.researcher", "RESEARCHER")
    assert_error(
        _add(api, project["project_id"], "b.researcher", "VIEWER"),
        409,
        "PROJECT_MEMBER_EXISTS",
        "addProjectMember",
    )
    assert_error(
        _add(api, project["project_id"], "a.researcher", "VIEWER"),
        409,
        "PROJECT_MEMBER_EXISTS",
        "addProjectMember",
    )


def test_at11_disabled_or_unknown_user_is_422(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    response = _add(api, project["project_id"], "b.disabled", "RESEARCHER")
    assert_error(response, 422, "VALIDATION_FAILED", "addProjectMember")
    assert response.json()["error"]["details"]["fields"] == [
        {"field": "user_id", "reason": "USER_NOT_ACTIVE"}
    ]
    unknown = api.post(
        "a.researcher",
        f"/projects/{project['project_id']}/members",
        json={"user_id": "00000000-0000-7000-8000-00000000ffff", "role": "VIEWER"},
    )
    assert_error(unknown, 422, "VALIDATION_FAILED", "addProjectMember")
    assert [e["event_type"] for e in project_events(db)] == ["project.created.v1"]


def test_member_limit_is_enforced(app: FastAPI, api: ProjectApi) -> None:
    app.dependency_overrides[get_project_settings] = lambda: ProjectSettings(project_max_members=2)
    project = api.create_project()
    assert _add(api, project["project_id"], "b.researcher", "RESEARCHER").status_code == 201
    response = _add(api, project["project_id"], "b.steward", "VIEWER")
    assert_error(response, 422, "VALIDATION_FAILED", "addProjectMember")
    assert response.json()["error"]["details"]["fields"][0]["reason"] == "PROJECT_MAX_MEMBERS"


def test_at13_archived_project_rejects_new_members(api: ProjectApi) -> None:
    project = api.create_project()
    api.post("a.researcher", f"/projects/{project['project_id']}/archive")
    assert_error(
        _add(api, project["project_id"], "b.researcher", "RESEARCHER"),
        409,
        "PROJECT_ARCHIVED",
        "addProjectMember",
    )


def test_invalid_role_is_422(api: ProjectApi) -> None:
    project = api.create_project()
    assert_error(
        _add(api, project["project_id"], "b.researcher", "OWNER"),
        422,
        "VALIDATION_FAILED",
        "addProjectMember",
    )
