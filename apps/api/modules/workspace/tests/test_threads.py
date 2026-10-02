"""Discussions (spec §5.6; openapi listThreads/createThread/updateThread/listComments/addComment)."""

from dataclasses import dataclass
from typing import Any
from uuid import UUID

import pytest

from api.modules.catalog.public import DatasetPolicyView
from api.modules.workspace.tests.conftest import WorkspaceApi, World, outbox
from api.modules.workspace.tests.fakes import ORG_B, USERS
from api.platform.ids import new_id
from api.platform.testing.contracts import assert_matches_response, assert_valid_event
from api.platform.testing.fixtures import PgUrls


@dataclass
class Setup:
    project_id: UUID
    public: DatasetPolicyView
    internal: DatasetPolicyView


@pytest.fixture
def setup(world: World) -> Setup:
    project_id = new_id()
    world.projects.add(project_id, USERS["a.owner"], "PROJECT_OWNER")
    world.projects.add(project_id, USERS["a.researcher"], "RESEARCHER")
    world.projects.add(project_id, USERS["a.viewer"], "VIEWER")
    public = world.catalog.add_dataset("공개 측정", "PUBLIC")
    world.catalog.add_version(public, "v1")
    internal = world.catalog.add_dataset("내부 자료", "INTERNAL")
    world.catalog.add_version(internal, "v1")
    return Setup(project_id, public, internal)


def create(api: WorkspaceApi, scope: str, target_id: UUID, user: str = "a.researcher", **extra: Any) -> Any:
    body = {"scope": scope, "target_id": str(target_id), "title": "온도 단위 확인", "body": "섭씨인가요?"}
    return api.post(user, "/threads", json=body | extra)


def error_code(response: Any) -> str:
    return str(response.json()["error"]["code"])


# ---------------------------------------------------------------- project threads


def test_member_creates_project_thread_and_event(api: WorkspaceApi, setup: Setup, db: PgUrls) -> None:
    response = create(api, "PROJECT", setup.project_id)
    assert response.status_code == 201, response.text
    assert_matches_response("createThread", 201, response.json())
    thread = response.json()
    assert thread["scope"] == "PROJECT"
    assert thread["project_id"] == thread["target_id"] == str(setup.project_id)
    assert (thread["comment_count"], thread["resolved"]) == (1, False)
    assert thread["created_by_display_name"] == "A Researcher"
    assert thread["last_comment_at"] == thread["created_at"]

    [event] = outbox(db)
    assert_valid_event(event)
    assert event["event_type"] == "workspace.comment.added.v1"
    payload = event["payload"]
    assert payload["project_id"] == str(setup.project_id)
    assert payload["new_thread"] is True
    assert payload["thread_id"] == thread["thread_id"]
    assert payload["thread_title"] == "온도 단위 확인"
    assert payload["owner_organization_id"] is None

    comments = api.get("a.viewer", f"/threads/{thread['thread_id']}/comments")
    assert comments.status_code == 200, comments.text
    assert_matches_response("listComments", 200, comments.json())
    [first] = comments.json()["items"]
    assert (first["body"], first["author_display_name"], first["edited_at"]) == (
        "섭씨인가요?",
        "A Researcher",
        None,
    )


def test_viewer_may_discuss(api: WorkspaceApi, setup: Setup) -> None:
    assert create(api, "PROJECT", setup.project_id, user="a.viewer").status_code == 201


def test_non_member_cannot_read_or_write_project_threads(api: WorkspaceApi, setup: Setup, db: PgUrls) -> None:
    response = create(api, "PROJECT", setup.project_id, user="a.outsider")
    assert (response.status_code, error_code(response)) == (404, "NOT_FOUND")
    assert outbox(db) == []
    thread_id = create(api, "PROJECT", setup.project_id).json()["thread_id"]
    for path in (
        f"/threads?project_id={setup.project_id}",
        f"/threads?scope=PROJECT&target_id={setup.project_id}",
    ):
        assert api.get("a.outsider", path).status_code == 404
    assert api.get("a.outsider", f"/threads/{thread_id}/comments").status_code == 404
    reply = api.post("a.outsider", f"/threads/{thread_id}/comments", json={"body": "끼어들기"})
    assert reply.status_code == 404
    assert api.patch("a.outsider", f"/threads/{thread_id}", json={"resolved": True}).status_code == 404


def test_archived_project_threads_are_readable_but_closed(
    api: WorkspaceApi, setup: Setup, world: World
) -> None:
    thread_id = create(api, "PROJECT", setup.project_id).json()["thread_id"]
    world.projects.archived.add(setup.project_id)
    assert api.get("a.researcher", f"/threads?project_id={setup.project_id}").status_code == 200
    reply = api.post("a.researcher", f"/threads/{thread_id}/comments", json={"body": "늦은 답"})
    assert (reply.status_code, error_code(reply)) == (403, "FORBIDDEN")
    assert create(api, "PROJECT", setup.project_id).status_code == 403


def test_output_and_recipe_targets_are_not_found_until_they_exist(api: WorkspaceApi, setup: Setup) -> None:
    for scope in ("OUTPUT", "RECIPE"):
        assert create(api, scope, new_id()).status_code == 404


def test_add_comment_bumps_thread_and_emits(api: WorkspaceApi, setup: Setup, db: PgUrls) -> None:
    thread = create(api, "PROJECT", setup.project_id).json()
    reply = api.post(
        "a.owner", f"/threads/{thread['thread_id']}/comments", json={"body": "**네**, 섭씨입니다."}
    )
    assert reply.status_code == 201, reply.text
    assert_matches_response("addComment", 201, reply.json())
    assert reply.json()["author_display_name"] == "A Owner"

    listed = api.get("a.researcher", f"/threads?project_id={setup.project_id}")
    assert_matches_response("listThreads", 200, listed.json())
    [row] = listed.json()["items"]
    assert row["comment_count"] == 2
    assert row["last_comment_at"] == reply.json()["created_at"]

    events = outbox(db)
    assert [e["payload"]["new_thread"] for e in events] == [True, False]
    assert events[1]["payload"]["comment_id"] == reply.json()["comment_id"]
    for event in events:
        assert_valid_event(event)

    comments = api.get("a.researcher", f"/threads/{thread['thread_id']}/comments").json()["items"]
    assert [c["body"] for c in comments] == ["섭씨인가요?", "**네**, 섭씨입니다."]


def test_markdown_body_limit_is_10000_characters(api: WorkspaceApi, setup: Setup, db: PgUrls) -> None:
    too_long = create(api, "PROJECT", setup.project_id, body="가" * 10_001)
    assert (too_long.status_code, error_code(too_long)) == (422, "VALIDATION_FAILED")
    thread_id = create(api, "PROJECT", setup.project_id, body="가" * 10_000).json()["thread_id"]
    reply = api.post("a.researcher", f"/threads/{thread_id}/comments", json={"body": "x" * 10_001})
    assert (reply.status_code, error_code(reply)) == (422, "VALIDATION_FAILED")
    assert api.post("a.researcher", f"/threads/{thread_id}/comments", json={"body": ""}).status_code == 422
    assert len(outbox(db)) == 1


def test_list_threads_requires_one_selector(api: WorkspaceApi, setup: Setup) -> None:
    for query in ("", "?scope=PROJECT", f"?target_id={setup.project_id}"):
        response = api.get("a.researcher", f"/threads{query}")
        assert (response.status_code, error_code(response)) == (422, "VALIDATION_FAILED"), query


def test_list_threads_newest_activity_first_with_paging_and_resolved_filter(
    api: WorkspaceApi, setup: Setup
) -> None:
    ids = [create(api, "PROJECT", setup.project_id, title=f"t{i}").json()["thread_id"] for i in range(3)]
    api.post("a.researcher", f"/threads/{ids[0]}/comments", json={"body": "bump"})
    first = api.get("a.researcher", f"/threads?project_id={setup.project_id}&limit=2").json()
    assert [t["thread_id"] for t in first["items"]] == [ids[0], ids[2]]
    assert first["page"]["has_more"] is True
    rest = api.get(
        "a.researcher",
        f"/threads?project_id={setup.project_id}&limit=2&cursor={first['page']['next_cursor']}",
    ).json()
    assert [t["thread_id"] for t in rest["items"]] == [ids[1]]
    assert api.patch("a.researcher", f"/threads/{ids[1]}", json={"resolved": True}).status_code == 200
    open_only = api.get("a.researcher", f"/threads?project_id={setup.project_id}&resolved=false").json()
    assert {t["thread_id"] for t in open_only["items"]} == {ids[0], ids[2]}
    bad = api.get("a.researcher", f"/threads?project_id={setup.project_id}&cursor=bm9wZQ")
    assert bad.status_code == 422


def test_update_thread_permissions_for_project_threads(api: WorkspaceApi, setup: Setup) -> None:
    thread_id = create(api, "PROJECT", setup.project_id).json()["thread_id"]
    denied = api.patch("a.viewer", f"/threads/{thread_id}", json={"resolved": True})
    assert (denied.status_code, error_code(denied)) == (403, "FORBIDDEN")
    by_author = api.patch("a.researcher", f"/threads/{thread_id}", json={"title": "단위 확인(수정)"})
    assert by_author.status_code == 200, by_author.text
    assert_matches_response("updateThread", 200, by_author.json())
    by_owner = api.patch("a.owner", f"/threads/{thread_id}", json={"resolved": True})
    assert by_owner.json()["resolved"] is True
    assert by_owner.json()["title"] == "단위 확인(수정)"
    for body in ({}, {"title": ""}, {"resolved": None}, {"extra": 1}):
        assert api.patch("a.owner", f"/threads/{thread_id}", json=body).status_code == 422, body


# ---------------------------------------------------------------- dataset threads


def test_any_signed_in_user_who_sees_the_dataset_may_discuss(
    api: WorkspaceApi, setup: Setup, db: PgUrls
) -> None:
    response = create(api, "DATASET", setup.public.dataset_id, user="a.outsider")
    assert response.status_code == 201, response.text
    thread = response.json()
    assert thread["project_id"] is None
    [event] = outbox(db)
    assert_valid_event(event)
    assert event["payload"]["project_id"] is None
    assert event["payload"]["scope"] == "DATASET"
    assert event["payload"]["owner_organization_id"] == str(ORG_B)

    other_org = api.post("b.researcher", f"/threads/{thread['thread_id']}/comments", json={"body": "확인"})
    assert other_org.status_code == 201
    listed = api.get("b.researcher", f"/threads?scope=DATASET&target_id={setup.public.dataset_id}")
    assert [t["thread_id"] for t in listed.json()["items"]] == [thread["thread_id"]]
    assert api.get(None, f"/threads/{thread['thread_id']}/comments").status_code == 401


def test_invisible_dataset_threads_are_not_found(api: WorkspaceApi, setup: Setup) -> None:
    assert create(api, "DATASET", setup.internal.dataset_id, user="b.researcher").status_code == 201
    assert create(api, "DATASET", setup.internal.dataset_id, user="a.researcher").status_code == 404
    listed = api.get("a.researcher", f"/threads?scope=DATASET&target_id={setup.internal.dataset_id}")
    assert listed.status_code == 404
    assert create(api, "DATASET", new_id()).status_code == 404


def test_dataset_thread_update_by_author_or_owner_steward(api: WorkspaceApi, setup: Setup) -> None:
    thread_id = create(api, "DATASET", setup.public.dataset_id).json()["thread_id"]
    for user in ("b.researcher", "a.steward"):  # other user / steward of another organization
        response = api.patch(user, f"/threads/{thread_id}", json={"resolved": True})
        assert (response.status_code, error_code(response)) == (403, "FORBIDDEN"), user
    assert api.patch("b.steward", f"/threads/{thread_id}", json={"resolved": True}).status_code == 200
    assert api.patch("a.researcher", f"/threads/{thread_id}", json={"resolved": False}).status_code == 200


def test_dataset_threads_do_not_appear_in_project_listing(api: WorkspaceApi, setup: Setup) -> None:
    create(api, "DATASET", setup.public.dataset_id)
    project_thread = create(api, "PROJECT", setup.project_id).json()["thread_id"]
    listed = api.get("a.researcher", f"/threads?project_id={setup.project_id}").json()["items"]
    assert [t["thread_id"] for t in listed] == [project_thread]


def test_unknown_thread_is_not_found(api: WorkspaceApi, setup: Setup) -> None:
    assert api.get("a.researcher", f"/threads/{new_id()}/comments").status_code == 404
    assert api.patch("a.researcher", f"/threads/{new_id()}", json={"resolved": True}).status_code == 404
