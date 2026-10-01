from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from api.modules.audit import fakes
from api.modules.audit.fakes import (
    A_RESEARCHER,
    A_STEWARD,
    ADMIN,
    B_RESEARCHER,
    B_STEWARD,
    ORG_A,
    ORG_B,
)
from api.modules.audit.handlers import audit_writer
from api.modules.audit.ports import ProjectQueryPort
from api.modules.audit.tests.support.auth import auth, make_client
from api.modules.audit.tests.support.db import run
from api.modules.audit.tests.support.events import (
    ACTOR_A,
    OTHER_PROJECT,
    PROJECT_GOLDEN,
    envelope,
)
from api.platform import ports
from api.platform.events import EventActor
from api.platform.pagination import encode_cursor
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls

T0 = datetime(2026, 10, 1, 9, 0, tzinfo=UTC)
ACTOR_B = EventActor(type="USER", user_id=B_RESEARCHER, organization_id=ORG_B)
ACTOR_B_ADMIN_OTHER = EventActor(type="USER", user_id=B_STEWARD, organization_id=ORG_B)


@pytest.fixture
def scenario(db: PgUrls) -> PgUrls:
    events = [
        envelope("identity.user.logged_in.v1", actor=ACTOR_A, occurred_at=T0),  # LOGIN a
        envelope(
            "identity.user.logged_in.v1",
            actor=ACTOR_B,
            occurred_at=T0 + timedelta(minutes=1),
            user_id=B_RESEARCHER,
            organization_id=ORG_B,
        ),  # LOGIN b
        envelope("governance.download.authorized.v1", actor=ACTOR_A, occurred_at=T0 + timedelta(minutes=2)),
        envelope("governance.download.denied.v1", actor=ACTOR_A, occurred_at=T0 + timedelta(minutes=3)),
        envelope("project.member.added.v1", actor=ACTOR_A, occurred_at=T0 + timedelta(minutes=4)),
        envelope(
            "project.created.v1",
            actor=ACTOR_B_ADMIN_OTHER,
            occurred_at=T0 + timedelta(minutes=5),
            project_id=OTHER_PROJECT,
            lead_organization_id=ORG_B,
            owner_user_id=B_STEWARD,
        ),
    ]
    for event in events:
        run(db, audit_writer, event)
    return db


def get(client: TestClient, user: UUID, **params: Any) -> Any:
    response = client.get("/api/v1/audit-events", params=params, headers=auth(user))
    assert_matches_response("listAuditEvents", response.status_code, response.json())
    return response


def actions(response: Any) -> list[str]:
    return [item["action"] for item in response.json()["items"]]


def test_unauthenticated_is_401(scenario: PgUrls) -> None:
    response = make_client(scenario).get("/api/v1/audit-events")
    assert response.status_code == 401 and response.json()["error"]["code"] == "UNAUTHENTICATED"
    assert_matches_response("listAuditEvents", 401, response.json())  # 401 declared by M00 (openapi 1.2.0)


def test_platform_admin_sees_everything_newest_first(scenario: PgUrls) -> None:
    response = get(make_client(scenario), ADMIN)
    assert actions(response) == [
        "PROJECT_CREATED",
        "PROJECT_MEMBER_ADDED",
        "DOWNLOAD_DENIED",
        "FILE_DOWNLOADED",
        "LOGIN",
        "LOGIN",
    ]
    item = response.json()["items"][0]
    assert item["actor"]["display_name"] == "B Steward" and item["resource"]["type"] == "PROJECT"


def test_researcher_sees_only_own_actions(scenario: PgUrls) -> None:  # M09-AT-04
    items = get(make_client(scenario), A_RESEARCHER).json()["items"]
    assert {i["actor"]["user_id"] for i in items} == {str(A_RESEARCHER)}
    assert sorted(i["action"] for i in items) == sorted(
        ["LOGIN", "FILE_DOWNLOADED", "DOWNLOAD_DENIED", "PROJECT_MEMBER_ADDED"]
    )


def test_project_member_sees_project_rows_except_download_denied(scenario: PgUrls) -> None:  # M09-AT-05
    response = get(make_client(scenario), B_RESEARCHER, project_id=str(PROJECT_GOLDEN))
    assert sorted(actions(response)) == ["FILE_DOWNLOADED", "PROJECT_MEMBER_ADDED"]


def test_member_of_archived_project_still_sees_its_rows(scenario: PgUrls) -> None:
    projects = fakes.FakeProjects(
        {PROJECT_GOLDEN: {A_RESEARCHER: "PROJECT_OWNER", B_RESEARCHER: "RESEARCHER"}},
        archived=[PROJECT_GOLDEN],
    )
    ports.provide(ProjectQueryPort, projects)  # a fresh fake: never mutate the cached seed singleton
    assert not projects.is_active_member(PROJECT_GOLDEN, B_RESEARCHER)  # is_active_member would wrongly 403
    response = get(make_client(scenario), B_RESEARCHER, project_id=str(PROJECT_GOLDEN))
    assert response.status_code == 200
    assert sorted(actions(response)) == ["FILE_DOWNLOADED", "PROJECT_MEMBER_ADDED"]


def test_non_member_project_is_403(scenario: PgUrls) -> None:  # M09-AT-06
    response = get(make_client(scenario), A_RESEARCHER, project_id=str(OTHER_PROJECT))
    assert response.status_code == 403 and response.json()["error"]["code"] == "FORBIDDEN"


def test_owner_steward_sees_foreign_download_of_own_data(scenario: PgUrls) -> None:  # M09-AT-07
    response = get(make_client(scenario), B_STEWARD, action=["FILE_DOWNLOADED"])
    [item] = response.json()["items"]
    assert item["actor"]["organization_id"] == str(ORG_A)
    assert item["resource"]["owner_organization_id"] == str(ORG_B)


def test_actor_org_steward_does_not_see_download_of_foreign_data(scenario: PgUrls) -> None:  # M09-AT-08
    assert actions(get(make_client(scenario), A_STEWARD, action=["FILE_DOWNLOADED"])) == []
    assert actions(get(make_client(scenario), A_STEWARD, action=["DOWNLOAD_DENIED"])) == []


def test_owner_steward_sees_download_denied(scenario: PgUrls) -> None:
    assert actions(get(make_client(scenario), B_STEWARD, action=["DOWNLOAD_DENIED"])) == ["DOWNLOAD_DENIED"]


def test_actor_org_steward_sees_own_org_users_non_download_actions(scenario: PgUrls) -> None:
    assert sorted(actions(get(make_client(scenario), A_STEWARD))) == ["LOGIN", "PROJECT_MEMBER_ADDED"]


def test_staff_non_member_project_filter_narrows_instead_of_403(scenario: PgUrls) -> None:
    response = get(make_client(scenario), A_STEWARD, project_id=str(PROJECT_GOLDEN))
    assert response.status_code == 200 and actions(response) == ["PROJECT_MEMBER_ADDED"]


def test_foreign_organization_filter_is_403_for_non_admin(scenario: PgUrls) -> None:
    response = get(make_client(scenario), A_RESEARCHER, organization_id=str(ORG_B))
    assert response.status_code == 403 and response.json()["error"]["code"] == "FORBIDDEN"
    assert get(make_client(scenario), A_RESEARCHER, organization_id=str(ORG_A)).status_code == 200


def test_filters_resource_and_time(scenario: PgUrls) -> None:
    client = make_client(scenario)
    assert actions(get(client, ADMIN, resource_type="PROJECT")) == ["PROJECT_CREATED"]
    assert actions(get(client, ADMIN, resource_id=str(OTHER_PROJECT))) == ["PROJECT_CREATED"]
    window = get(
        client,
        ADMIN,
        **{
            "from": (T0 + timedelta(minutes=2)).isoformat(),
            "to": (T0 + timedelta(minutes=4)).isoformat(),
        },
    )
    assert actions(window) == ["DOWNLOAD_DENIED", "FILE_DOWNLOADED"]
    assert actions(get(client, ADMIN, actor_user_id=str(B_RESEARCHER))) == ["LOGIN"]


def test_cursor_pagination_walks_all_rows_once(scenario: PgUrls) -> None:
    client = make_client(scenario)
    seen: list[str] = []
    cursor: str | None = None
    while True:
        params: dict[str, Any] = {"limit": 2}
        if cursor:
            params["cursor"] = cursor
        body = get(client, ADMIN, **params).json()
        seen += [i["audit_event_id"] for i in body["items"]]
        if not body["page"]["has_more"]:
            assert body["page"]["next_cursor"] is None
            break
        cursor = body["page"]["next_cursor"]
    assert len(seen) == len(set(seen)) == 6


def test_page_sizes_are_full_under_visibility_filter(scenario: PgUrls) -> None:
    """Visibility is a SQL predicate: A_RESEARCHER has 4 visible rows, so limit=3 gives 3 then 1 (no post-filter gaps)."""
    client = make_client(scenario)
    first = get(client, A_RESEARCHER, limit=3).json()
    assert len(first["items"]) == 3 and first["page"]["has_more"]
    second = get(client, A_RESEARCHER, limit=3, cursor=first["page"]["next_cursor"]).json()
    assert len(second["items"]) == 1 and not second["page"]["has_more"]


@pytest.mark.parametrize(
    "cursor",
    [
        "!!!",
        encode_cursor(["not-a-date", "x"]),
        encode_cursor(["2026-10-01T00:00:00+00:00"]),
        encode_cursor(["2026-10-01T00:00:00", "00000000-0000-0000-0000-000000000000"]),
    ],
)
def test_malformed_cursor_is_422(scenario: PgUrls, cursor: str) -> None:  # Review Focus 3
    response = make_client(scenario).get(
        "/api/v1/audit-events", params={"cursor": cursor}, headers=auth(ADMIN)
    )
    assert response.status_code == 422 and response.json()["error"]["code"] == "VALIDATION_FAILED"
    assert response.json()["error"]["details"]["fields"][0]["reason"] == "INVALID_CURSOR"


def test_unknown_action_filter_is_422(scenario: PgUrls) -> None:
    response = make_client(scenario).get(
        "/api/v1/audit-events", params={"action": "NOPE"}, headers=auth(ADMIN)
    )
    assert response.status_code == 422
