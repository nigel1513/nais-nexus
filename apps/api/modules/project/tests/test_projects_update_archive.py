from datetime import datetime

from api.modules.project.tests.helpers import ProjectApi, assert_error, project_events, seed_member, uid
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


def test_owner_updates_fields_without_event(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    response = api.patch(
        "a.researcher",
        f"/projects/{project['project_id']}",
        json={"name": "Renamed Study", "description": "New text", "keywords": ["k1"], "visibility": "PUBLIC"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert_matches_response("updateProject", 200, body)
    assert (body["name"], body["description"], body["keywords"], body["visibility"]) == (
        "Renamed Study",
        "New text",
        ["k1"],
        "PUBLIC",
    )
    assert datetime.fromisoformat(body["updated_at"]) > datetime.fromisoformat(project["updated_at"])
    assert [e["event_type"] for e in project_events(db)] == ["project.created.v1"]


def test_admin_edits_but_cannot_change_visibility(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "a.admin", "PROJECT_ADMIN")
    path = f"/projects/{project['project_id']}"
    assert api.patch("a.admin", path, json={"description": "by admin"}).status_code == 200
    assert api.patch("a.admin", path, json={"visibility": "PRIVATE"}).status_code == 200  # unchanged value
    assert_error(api.patch("a.admin", path, json={"visibility": "PUBLIC"}), 403, "FORBIDDEN", "updateProject")


def test_researcher_and_viewer_cannot_edit(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "b.researcher", "RESEARCHER")
    seed_member(db, project["project_id"], "b.steward", "VIEWER")
    for user in ("b.researcher", "b.steward"):
        response = api.patch(user, f"/projects/{project['project_id']}", json={"description": "x"})
        assert_error(response, 403, "FORBIDDEN", "updateProject")


def test_non_member_update_is_404_on_private_and_admin_cannot_write(api: ProjectApi) -> None:
    project = api.create_project()
    path = f"/projects/{project['project_id']}"
    assert_error(api.patch("b.steward", path, json={"description": "x"}), 404, "NOT_FOUND", "updateProject")
    assert_error(api.patch("admin", path, json={"description": "x"}), 403, "FORBIDDEN", "updateProject")


def test_patch_rejects_empty_body_and_nulls(api: ProjectApi) -> None:
    project = api.create_project()
    path = f"/projects/{project['project_id']}"
    assert_error(api.patch("a.researcher", path, json={}), 422, "VALIDATION_FAILED", "updateProject")
    for field in ("name", "description", "visibility", "keywords"):
        assert_error(
            api.patch("a.researcher", path, json={field: None}), 422, "VALIDATION_FAILED", "updateProject"
        )


def test_patch_dates_are_checked_against_stored_values(api: ProjectApi) -> None:
    project = api.create_project(start_date="2026-10-10")
    path = f"/projects/{project['project_id']}"
    response = api.patch("a.researcher", path, json={"end_date": "2026-10-01"})
    assert_error(response, 422, "VALIDATION_FAILED", "updateProject")
    assert response.json()["error"]["details"]["fields"][0]["field"] == "end_date"
    cleared = api.patch("a.researcher", path, json={"start_date": None, "end_date": "2026-10-01"})
    assert cleared.status_code == 200
    assert (cleared.json()["start_date"], cleared.json()["end_date"]) == (None, "2026-10-01")


def test_owner_archives_once(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    path = f"/projects/{project['project_id']}/archive"
    response = api.post("a.researcher", path)
    assert response.status_code == 200, response.text
    body = response.json()
    assert_matches_response("archiveProject", 200, body)
    assert body["status"] == "ARCHIVED" and body["archived_at"] is not None
    events = project_events(db)
    assert [e["event_type"] for e in events] == ["project.created.v1", "project.archived.v1"]
    assert events[1]["payload"] == {"project_id": project["project_id"]}
    assert events[1]["actor"]["user_id"] == uid("a.researcher")
    assert_error(api.post("a.researcher", path), 409, "PROJECT_ARCHIVED", "archiveProject")
    assert api.get("a.researcher", f"/projects/{project['project_id']}").status_code == 200  # still readable


def test_only_owner_archives(api: ProjectApi, db: PgUrls) -> None:
    project = api.create_project()
    seed_member(db, project["project_id"], "a.admin", "PROJECT_ADMIN")
    assert_error(
        api.post("a.admin", f"/projects/{project['project_id']}/archive"), 403, "FORBIDDEN", "archiveProject"
    )


def test_at13_archived_project_rejects_updates(api: ProjectApi) -> None:
    project = api.create_project()
    api.post("a.researcher", f"/projects/{project['project_id']}/archive")
    response = api.patch("a.researcher", f"/projects/{project['project_id']}", json={"description": "late"})
    assert_error(response, 409, "PROJECT_ARCHIVED", "updateProject")
