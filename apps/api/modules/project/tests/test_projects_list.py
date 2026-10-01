from datetime import UTC, datetime

from api.modules.project.tests.helpers import ProjectApi, assert_error, sql
from api.platform import clock
from api.platform.pagination import encode_cursor
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


def _names(response_json: dict) -> list[str]:  # type: ignore[type-arg]
    return [item["name"] for item in response_json["items"]]


def test_mine_lists_my_projects_newest_first(api: ProjectApi) -> None:
    api.create_project(name="First Study")
    api.create_project(name="Second Study")
    api.create_project(user="b.researcher", name="Other Institute Study")
    response = api.get("a.researcher", "/projects")
    assert response.status_code == 200
    body = response.json()
    assert_matches_response("listProjects", 200, body)
    assert _names(body) == ["Second Study", "First Study"]
    assert {item["my_role"] for item in body["items"]} == {"PROJECT_OWNER"}
    assert {item["member_count"] for item in body["items"]} == {1}
    assert body["page"] == {"next_cursor": None, "has_more": False}


def test_mine_includes_archived_and_filters_by_status(api: ProjectApi, db: PgUrls) -> None:
    archived = api.create_project(name="Archived Study")
    api.create_project(name="Active Study")
    sql(
        db,
        "UPDATE project.projects SET status = 'ARCHIVED' WHERE project_id = :id",
        id=archived["project_id"],
    )
    assert set(_names(api.get("a.researcher", "/projects").json())) == {"Archived Study", "Active Study"}
    assert _names(api.get("a.researcher", "/projects", params={"status": "ARCHIVED"}).json()) == [
        "Archived Study"
    ]
    assert _names(api.get("a.researcher", "/projects", params={"status": "ACTIVE"}).json()) == [
        "Active Study"
    ]


def test_at05_discover_lists_public_active_projects_only(api: ProjectApi, db: PgUrls) -> None:
    api.create_project(name="Open Study", visibility="PUBLIC")
    api.create_project(name="Closed Study")
    old = api.create_project(name="Old Public Study", visibility="PUBLIC")
    sql(db, "UPDATE project.projects SET status = 'ARCHIVED' WHERE project_id = :id", id=old["project_id"])

    stranger = api.get("b.steward", "/projects", params={"scope": "discover"})
    assert stranger.status_code == 200
    assert_matches_response("listProjects", 200, stranger.json())
    assert _names(stranger.json()) == ["Open Study"]
    assert stranger.json()["items"][0]["my_role"] is None
    assert stranger.json()["items"][0]["member_count"] == 1

    owner = api.get("a.researcher", "/projects", params={"scope": "discover"}).json()
    assert [(i["name"], i["my_role"]) for i in owner["items"]] == [("Open Study", "PROJECT_OWNER")]
    assert api.get("b.steward", "/projects").json()["items"] == []


def test_q_is_case_insensitive_and_wildcards_are_literal(api: ProjectApi) -> None:
    api.create_project(name="100% Solar")
    api.create_project(name="1000 Solar Cells")
    assert _names(api.get("a.researcher", "/projects", params={"q": "solar"}).json()) == [
        "1000 Solar Cells",
        "100% Solar",
    ]
    assert _names(api.get("a.researcher", "/projects", params={"q": "100%"}).json()) == ["100% Solar"]
    assert _names(api.get("a.researcher", "/projects", params={"q": "0_S"}).json()) == []
    assert len(api.get("a.researcher", "/projects", params={"q": "   "}).json()["items"]) == 2


def test_cursor_pages_through_identical_timestamps(api: ProjectApi) -> None:
    with clock.frozen(datetime(2026, 10, 1, 9, 0, tzinfo=UTC)):
        for index in range(3):
            api.create_project(name=f"Tied Study {index}")
    first = api.get("a.researcher", "/projects", params={"limit": 2}).json()
    assert len(first["items"]) == 2 and first["page"]["has_more"] is True
    second = api.get(
        "a.researcher", "/projects", params={"limit": 2, "cursor": first["page"]["next_cursor"]}
    ).json()
    assert len(second["items"]) == 1 and second["page"] == {"next_cursor": None, "has_more": False}
    seen = [i["project_id"] for i in first["items"] + second["items"]]
    assert len(set(seen)) == 3


def test_tampered_cursor_is_422(api: ProjectApi) -> None:
    api.create_project()
    garbage = api.get("a.researcher", "/projects", params={"cursor": "not-a-cursor!!"})
    assert_error(garbage, 422, "VALIDATION_FAILED", "listProjects")
    foreign = api.get("a.researcher", "/projects", params={"cursor": encode_cursor(["x"])})
    assert_error(foreign, 422, "VALIDATION_FAILED", "listProjects")
    assert foreign.json()["error"]["details"]["fields"][0] == {"field": "cursor", "reason": "INVALID_CURSOR"}
    naive = api.get(
        "a.researcher",
        "/projects",
        params={"cursor": encode_cursor(["2026-10-01T00:00:00", "00000000-0000-7000-8000-000000000001"])},
    )
    assert_error(naive, 422, "VALIDATION_FAILED", "listProjects")


def test_invalid_scope_is_422_and_token_required(api: ProjectApi) -> None:
    assert_error(
        api.get("a.researcher", "/projects", params={"scope": "all"}),
        422,
        "VALIDATION_FAILED",
        "listProjects",
    )
    assert_error(api.get(None, "/projects"), 401, "UNAUTHENTICATED", "listProjects")
