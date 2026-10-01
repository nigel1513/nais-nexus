from api.modules.project.seed_data import ORG_A
from api.modules.project.tests.helpers import ProjectApi, assert_error, project_events, sql, uid
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


def test_at01_creator_becomes_owner_and_lead(api: ProjectApi, db: PgUrls) -> None:
    response = api.post(
        "a.researcher", "/projects", json={"name": "Battery Study", "description": "Joint work"}
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert_matches_response("createProject", 201, body)
    assert body["lead_organization_id"] == str(ORG_A)
    assert body["my_role"] == "PROJECT_OWNER"
    assert body["visibility"] == "PRIVATE"
    assert body["status"] == "ACTIVE"
    assert body["member_count"] == 1
    assert body["created_by"] == uid("a.researcher")
    assert body["archived_at"] is None
    assert body["organizations"] == [{"organization_id": str(ORG_A), "name": "Institute A", "role": "LEAD"}]

    members = sql(db, "SELECT user_id::text, role, status FROM project.project_members")
    assert members == [{"user_id": uid("a.researcher"), "role": "PROJECT_OWNER", "status": "ACTIVE"}]

    events = project_events(db)
    assert [e["event_type"] for e in events] == ["project.created.v1"]  # no member.added for the creator
    assert events[0]["payload"] == {
        "project_id": body["project_id"],
        "name": "Battery Study",
        "lead_organization_id": str(ORG_A),
        "visibility": "PRIVATE",
        "owner_user_id": uid("a.researcher"),
    }
    assert events[0]["actor"] == {
        "type": "USER",
        "user_id": uid("a.researcher"),
        "organization_id": str(ORG_A),
    }


def test_create_with_optional_fields(api: ProjectApi) -> None:
    body = api.create_project(
        visibility="PUBLIC", keywords=["battery", " anode "], start_date="2026-10-01", end_date="2027-03-31"
    )
    assert body["visibility"] == "PUBLIC"
    assert body["keywords"] == ["battery", "anode"]
    assert body["start_date"] == "2026-10-01"
    assert body["end_date"] == "2027-03-31"


def test_create_rejects_end_before_start(api: ProjectApi, db: PgUrls) -> None:
    response = api.post(
        "a.researcher",
        "/projects",
        json={"name": "Study", "description": "", "start_date": "2026-10-02", "end_date": "2026-10-01"},
    )
    assert_error(response, 422, "VALIDATION_FAILED", "createProject")
    assert response.json()["error"]["details"]["fields"][0]["field"] == "end_date"
    assert sql(db, "SELECT count(*) AS n FROM project.projects") == [{"n": 0}]


def test_create_blank_name_is_rejected_and_padding_trimmed(api: ProjectApi) -> None:
    blank = api.post("a.researcher", "/projects", json={"name": "   ", "description": ""})
    assert_error(blank, 422, "VALIDATION_FAILED", "createProject")
    assert api.create_project(name="  ab  ")["name"] == "ab"


def test_create_rejects_unknown_fields(api: ProjectApi) -> None:
    response = api.post("a.researcher", "/projects", json={"name": "Study", "description": "", "owner": "x"})
    assert_error(response, 422, "VALIDATION_FAILED", "createProject")


def test_create_requires_a_token(api: ProjectApi) -> None:
    assert_error(
        api.post(None, "/projects", json={"name": "Study", "description": ""}),
        401,
        "UNAUTHENTICATED",
        "createProject",
    )


def test_member_reads_project(api: ProjectApi) -> None:
    project = api.create_project()
    response = api.get("a.researcher", f"/projects/{project['project_id']}")
    assert response.status_code == 200
    assert_matches_response("getProject", 200, response.json())
    assert response.json()["my_role"] == "PROJECT_OWNER"


def test_at04_private_project_is_404_for_non_member(api: ProjectApi) -> None:
    project = api.create_project()
    response = api.get("b.steward", f"/projects/{project['project_id']}")
    assert_error(response, 404, "NOT_FOUND", "getProject")


def test_at05_public_project_detail_is_403_for_non_member(api: ProjectApi) -> None:
    project = api.create_project(visibility="PUBLIC")
    response = api.get("b.steward", f"/projects/{project['project_id']}")
    assert_error(response, 403, "FORBIDDEN", "getProject")


def test_platform_admin_reads_private_project_without_role(api: ProjectApi) -> None:
    project = api.create_project()
    response = api.get("admin", f"/projects/{project['project_id']}")
    assert response.status_code == 200
    assert response.json()["my_role"] is None


def test_unknown_project_is_404(api: ProjectApi) -> None:
    response = api.get("a.researcher", "/projects/00000000-0000-7000-8000-00000000ffff")
    assert_error(response, 404, "NOT_FOUND", "getProject")
