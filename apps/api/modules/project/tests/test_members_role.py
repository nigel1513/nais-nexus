from api.modules.project.tests.helpers import ProjectApi, assert_error, project_events, seed_member, uid
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


def _set_role(api: ProjectApi, project_id: str, key: str, role: str, by: str = "a.researcher"):  # type: ignore[no-untyped-def]
    return api.patch(by, f"/projects/{project_id}/members/{uid(key)}", json={"role": role})


def test_owner_promotes_member_and_event_is_emitted(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    response = _set_role(api, project["project_id"], "b.researcher", "PROJECT_ADMIN")
    assert response.status_code == 200, response.text
    assert_matches_response("updateProjectMemberRole", 200, response.json())
    assert response.json()["role"] == "PROJECT_ADMIN"
    event = project_events(db)[-1]
    assert event["event_type"] == "project.member.role_changed.v1"
    assert event["payload"] == {
        "project_id": project["project_id"],
        "user_id": uid("b.researcher"),
        "previous_role": "RESEARCHER",
        "role": "PROJECT_ADMIN",
        "changed_by": uid("a.researcher"),
    }


def test_same_role_is_200_without_event(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    assert _set_role(api, project["project_id"], "b.researcher", "RESEARCHER").status_code == 200
    assert [e["event_type"] for e in project_events(db)] == ["project.created.v1"]


def test_at07_second_owner_can_be_demoted_but_not_the_last(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "a.admin", "PROJECT_OWNER")
    assert _set_role(api, project["project_id"], "a.admin", "RESEARCHER").status_code == 200
    response = _set_role(
        api, project["project_id"], "a.researcher", "PROJECT_ADMIN"
    )  # self-demotion, last owner
    assert_error(response, 409, "PROJECT_LAST_OWNER", "updateProjectMemberRole")


def test_at08_admin_cannot_grant_owner(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "a.admin", "PROJECT_ADMIN")
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    response = _set_role(api, project["project_id"], "b.researcher", "PROJECT_OWNER", by="a.admin")
    assert_error(response, 403, "FORBIDDEN", "updateProjectMemberRole")


def test_admin_scope_is_researcher_and_viewer(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "a.admin", "PROJECT_ADMIN")
    seed_member(db, project["project_id"], "a.steward", "PROJECT_ADMIN")
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    assert _set_role(api, project["project_id"], "b.researcher", "VIEWER", by="a.admin").status_code == 200
    for key, role in (
        ("b.researcher", "PROJECT_ADMIN"),
        ("a.steward", "RESEARCHER"),
        ("a.admin", "RESEARCHER"),
        ("a.researcher", "RESEARCHER"),
    ):
        response = _set_role(api, project["project_id"], key, role, by="a.admin")
        assert_error(response, 403, "FORBIDDEN", "updateProjectMemberRole")


def test_researcher_cannot_change_roles(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    seed_member(db, project["project_id"], "b.steward", "VIEWER")
    response = _set_role(api, project["project_id"], "b.steward", "RESEARCHER", by="b.researcher")
    assert_error(response, 403, "FORBIDDEN", "updateProjectMemberRole")


def test_unknown_member_is_404(api: ProjectApi) -> None:
    project = api.create_project()
    assert_error(
        _set_role(api, project["project_id"], "b.steward", "VIEWER"),
        404,
        "PROJECT_MEMBER_NOT_FOUND",
        "updateProjectMemberRole",
    )


def test_archived_project_rejects_role_change(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    api.post("a.researcher", f"/projects/{project['project_id']}/archive")
    response = _set_role(api, project["project_id"], "b.researcher", "VIEWER")
    assert_error(response, 409, "PROJECT_ARCHIVED", "updateProjectMemberRole")


def test_invalid_role_body_is_422(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    assert_error(
        _set_role(api, project["project_id"], "b.researcher", "ADMIN"),
        422,
        "VALIDATION_FAILED",
        "updateProjectMemberRole",
    )
