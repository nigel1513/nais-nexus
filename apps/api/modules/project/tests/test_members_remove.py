from api.modules.project.seed_data import ORG_A, ORG_B
from api.modules.project.tests.helpers import ProjectApi, assert_error, project_events, seed_member, sql, uid
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


def _remove(api: ProjectApi, project_id: str, key: str, by: str = "a.researcher"):  # type: ignore[no-untyped-def]
    return api.delete(by, f"/projects/{project_id}/members/{uid(key)}")


def _org_roles(api: ProjectApi, project_id: str) -> list[tuple[str, str]]:
    detail = api.get("a.researcher", f"/projects/{project_id}").json()
    return [(o["organization_id"], o["role"]) for o in detail["organizations"]]


def test_at12_removing_last_partner_member_drops_partner_row(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    api.post(
        "a.researcher",
        f"/projects/{project['project_id']}/members",
        json={"user_id": uid("b.researcher"), "role": "RESEARCHER"},
    )
    response = _remove(api, project["project_id"], "b.researcher")
    assert response.status_code == 204
    assert_matches_response("removeProjectMember", 204, response.content)
    assert _org_roles(api, project["project_id"]) == [(str(ORG_A), "LEAD")]
    event = project_events(db)[-1]
    assert event["event_type"] == "project.member.removed.v1"
    assert event["payload"] == {
        "project_id": project["project_id"],
        "user_id": uid("b.researcher"),
        "organization_id": str(ORG_B),
        "removed_by": uid("a.researcher"),
        "reason": None,
    }
    history = sql(
        db,
        "SELECT status, removed_by::text, removed_at IS NOT NULL AS stamped FROM project.project_members WHERE user_id = :u",
        u=uid("b.researcher"),
    )
    assert history == [{"status": "REMOVED", "removed_by": uid("a.researcher"), "stamped": True}]
    assert_error(
        api.get("b.researcher", f"/projects/{project['project_id']}"), 404, "NOT_FOUND", "getProject"
    )


def test_partner_row_stays_while_institute_has_members(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    seed_member(db, project["project_id"], "b.steward", "VIEWER")
    assert _remove(api, project["project_id"], "b.steward").status_code == 204
    assert _org_roles(api, project["project_id"]) == [(str(ORG_A), "LEAD"), (str(ORG_B), "PARTNER")]


def test_member_leaves_on_their_own(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "b.researcher", "VIEWER")
    assert _remove(api, project["project_id"], "b.researcher", by="b.researcher").status_code == 204
    assert project_events(db)[-1]["payload"]["removed_by"] == uid("b.researcher")


def test_at06_sole_owner_cannot_leave(api: ProjectApi) -> None:
    project = api.create_project()
    response = _remove(api, project["project_id"], "a.researcher", by="a.researcher")
    assert_error(response, 409, "PROJECT_LAST_OWNER", "removeProjectMember")


def test_owner_can_leave_when_another_owner_remains(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "a.admin", "PROJECT_OWNER")
    assert _remove(api, project["project_id"], "a.researcher", by="a.researcher").status_code == 204


def test_admin_removes_researchers_but_not_owners_or_admins(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "a.admin", "PROJECT_ADMIN")
    seed_member(db, project["project_id"], "a.steward", "PROJECT_ADMIN")
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    assert _remove(api, project["project_id"], "b.researcher", by="a.admin").status_code == 204
    for key in ("a.researcher", "a.steward"):
        assert_error(
            _remove(api, project["project_id"], key, by="a.admin"), 403, "FORBIDDEN", "removeProjectMember"
        )


def test_viewer_cannot_remove_others(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "b.steward", "VIEWER")
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    assert_error(
        _remove(api, project["project_id"], "b.researcher", by="b.steward"),
        403,
        "FORBIDDEN",
        "removeProjectMember",
    )


def test_removing_non_member_is_404(api: ProjectApi) -> None:
    project = api.create_project()
    response = _remove(api, project["project_id"], "b.steward")
    assert_error(response, 404, "PROJECT_MEMBER_NOT_FOUND", "removeProjectMember")


def test_archived_project_allows_leave_but_not_removal(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    seed_member(db, project["project_id"], "b.steward", "VIEWER")
    api.post("a.researcher", f"/projects/{project['project_id']}/archive")
    assert_error(
        _remove(api, project["project_id"], "b.researcher"), 409, "PROJECT_ARCHIVED", "removeProjectMember"
    )
    assert _remove(api, project["project_id"], "b.steward", by="b.steward").status_code == 204
    assert_error(
        _remove(api, project["project_id"], "a.researcher", by="a.researcher"),
        409,
        "PROJECT_LAST_OWNER",
        "removeProjectMember",
    )


def test_removed_member_can_be_added_again(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    path = f"/projects/{project['project_id']}/members"
    api.post("a.researcher", path, json={"user_id": uid("b.researcher"), "role": "RESEARCHER"})
    _remove(api, project["project_id"], "b.researcher")
    again = api.post("a.researcher", path, json={"user_id": uid("b.researcher"), "role": "VIEWER"})
    assert again.status_code == 201, again.text
    rows = sql(
        db,
        "SELECT status, role FROM project.project_members WHERE user_id = :u ORDER BY joined_at",
        u=uid("b.researcher"),
    )
    assert rows == [{"status": "REMOVED", "role": "RESEARCHER"}, {"status": "ACTIVE", "role": "VIEWER"}]
    counts = sql(
        db,
        "SELECT role, active_member_count FROM project.project_organizations WHERE organization_id = :o",
        o=str(ORG_B),
    )
    assert counts == [{"role": "PARTNER", "active_member_count": 1}]
