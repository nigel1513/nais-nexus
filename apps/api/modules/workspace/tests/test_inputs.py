"""Pinned dataset inputs (spec §5.2; openapi listProjectInputs/addProjectInput/updateProjectInput/removeProjectInput)."""

from dataclasses import dataclass
from typing import Any
from uuid import UUID

import pytest

from api.modules.catalog.public import DatasetPolicyView, VersionView
from api.modules.workspace.tests.conftest import WorkspaceApi, World, outbox, sql
from api.modules.workspace.tests.fakes import ORG_A, USERS
from api.platform.ids import new_id
from api.platform.testing.contracts import assert_matches_response, assert_valid_event
from api.platform.testing.fixtures import PgUrls


@dataclass
class Setup:
    project_id: UUID
    public: DatasetPolicyView
    public_v1: VersionView
    controlled: DatasetPolicyView
    controlled_v1: VersionView
    internal: DatasetPolicyView

    @property
    def inputs(self) -> str:
        return f"/projects/{self.project_id}/inputs"


@pytest.fixture
def setup(world: World) -> Setup:
    project_id = new_id()
    world.projects.add(project_id, USERS["a.researcher"], "RESEARCHER")
    world.projects.add(project_id, USERS["a.viewer"], "VIEWER")
    world.projects.add(project_id, USERS["b.researcher"], "RESEARCHER")
    public = world.catalog.add_dataset("공개 측정", "PUBLIC")
    public_v1 = world.catalog.add_version(public, "v1")
    controlled = world.catalog.add_dataset("이차전지 충방전 측정", "CONTROLLED")
    controlled_v1 = world.catalog.add_version(controlled, "v1")
    internal = world.catalog.add_dataset("내부 자료", "INTERNAL")
    world.catalog.add_version(internal, "v1")
    return Setup(project_id, public, public_v1, controlled, controlled_v1, internal)


def add(api: WorkspaceApi, s: Setup, dataset_id: UUID, user: str = "a.researcher", **extra: Any) -> Any:
    return api.post(user, s.inputs, json={"dataset_id": str(dataset_id), **extra})


def error_code(response: Any) -> str:
    return str(response.json()["error"]["code"])


# ---------------------------------------------------------------- add


def test_add_public_input_pins_latest_version_and_emits_event(
    api: WorkspaceApi, setup: Setup, db: PgUrls
) -> None:
    response = add(api, setup, setup.public.dataset_id, note="온도 구간별 비교용")
    assert response.status_code == 201, response.text
    assert_matches_response("addProjectInput", 201, response.json())
    body = response.json()
    assert body["dataset_version_id"] == str(setup.public_v1.dataset_version_id)
    assert body["dataset_title"] == "공개 측정"
    assert body["version_label"] == "v1"
    assert body["newer_version_label"] is None
    assert body["access_level"] == "PUBLIC"
    assert body["access_lapsed"] is False
    assert body["added_by"] == str(USERS["a.researcher"].user_id)
    assert body["added_by_display_name"] == "A Researcher"
    assert body["note"] == "온도 구간별 비교용"

    [event] = outbox(db)
    assert_valid_event(event)
    assert event["event_type"] == "workspace.input.added.v1"
    assert event["actor"]["user_id"] == str(USERS["a.researcher"].user_id)
    payload = event["payload"]
    assert payload["input_id"] == body["input_id"]
    assert payload["project_id"] == str(setup.project_id)
    assert payload["dataset_version_id"] == str(setup.public_v1.dataset_version_id)
    assert payload["owner_organization_id"] == str(setup.public.owner_organization_id)
    assert (payload["dataset_title"], payload["version_label"]) == ("공개 측정", "v1")


def test_add_explicit_version(api: WorkspaceApi, setup: Setup, world: World) -> None:
    v2 = world.catalog.add_version(setup.public, "v2")
    response = add(
        api, setup, setup.public.dataset_id, dataset_version_id=str(setup.public_v1.dataset_version_id)
    )
    assert response.status_code == 201, response.text
    assert response.json()["version_label"] == "v1"
    assert response.json()["newer_version_label"] == v2.version_label


def test_non_member_cannot_add(api: WorkspaceApi, setup: Setup, db: PgUrls) -> None:
    response = add(api, setup, setup.public.dataset_id, user="a.outsider")
    assert response.status_code == 403
    assert error_code(response) == "FORBIDDEN"
    assert outbox(db) == []


def test_viewer_cannot_add(api: WorkspaceApi, setup: Setup) -> None:
    response = add(api, setup, setup.public.dataset_id, user="a.viewer")
    assert (response.status_code, error_code(response)) == (403, "FORBIDDEN")


def test_archived_project_rejects_new_inputs(api: WorkspaceApi, setup: Setup, world: World) -> None:
    world.projects.archived.add(setup.project_id)
    response = add(api, setup, setup.public.dataset_id)
    assert (response.status_code, error_code(response)) == (409, "PROJECT_ARCHIVED")


def test_invisible_dataset_is_not_found(api: WorkspaceApi, setup: Setup) -> None:
    response = add(api, setup, setup.internal.dataset_id)  # INTERNAL of org B, caller is org A
    assert (response.status_code, error_code(response)) == (404, "NOT_FOUND")
    assert add(api, setup, new_id()).status_code == 404


def test_controlled_without_grant_requires_access(api: WorkspaceApi, setup: Setup, db: PgUrls) -> None:
    response = add(api, setup, setup.controlled.dataset_id)
    assert response.status_code == 403
    error = response.json()["error"]
    assert error["code"] == "ACCESS_REQUIRED"
    assert error["details"] == {"dataset_id": str(setup.controlled.dataset_id)}
    assert outbox(db) == []


def test_controlled_with_active_grant_is_added(api: WorkspaceApi, setup: Setup, world: World) -> None:
    world.grants.grant(USERS["a.researcher"], setup.controlled.dataset_id)
    response = add(api, setup, setup.controlled.dataset_id)
    assert response.status_code == 201, response.text
    assert response.json()["access_level"] == "CONTROLLED"
    assert response.json()["access_lapsed"] is False


def test_owner_organization_member_needs_no_grant(api: WorkspaceApi, setup: Setup) -> None:
    response = add(api, setup, setup.controlled.dataset_id, user="b.researcher")
    assert response.status_code == 201, response.text


def test_version_must_be_published_and_belong_to_the_dataset(
    api: WorkspaceApi, setup: Setup, world: World
) -> None:
    draft = world.catalog.add_version(setup.public, "v2-draft", status="DRAFT")
    response = add(api, setup, setup.public.dataset_id, dataset_version_id=str(draft.dataset_version_id))
    assert (response.status_code, error_code(response)) == (409, "DATASET_VERSION_NOT_PUBLISHED")

    other = add(
        api, setup, setup.public.dataset_id, dataset_version_id=str(setup.controlled_v1.dataset_version_id)
    )
    assert (other.status_code, error_code(other)) == (422, "VALIDATION_FAILED")

    unknown = add(api, setup, setup.public.dataset_id, dataset_version_id=str(new_id()))
    assert (unknown.status_code, error_code(unknown)) == (404, "NOT_FOUND")


def test_dataset_without_published_version_cannot_be_pinned(
    api: WorkspaceApi, setup: Setup, world: World
) -> None:
    own = world.catalog.add_dataset("작성 중", "PUBLIC", owner=ORG_A)  # visible to its owner organization
    world.catalog.add_version(own, "v1", status="DRAFT")
    response = add(api, setup, own.dataset_id)
    assert (response.status_code, error_code(response)) == (409, "DATASET_VERSION_NOT_PUBLISHED")


def test_duplicate_input_conflicts_until_removed(api: WorkspaceApi, setup: Setup) -> None:
    first = add(api, setup, setup.public.dataset_id)
    assert first.status_code == 201
    again = add(api, setup, setup.public.dataset_id)
    assert (again.status_code, error_code(again)) == (409, "CONFLICT")
    assert api.delete("a.researcher", f"{setup.inputs}/{first.json()['input_id']}").status_code == 204
    assert add(api, setup, setup.public.dataset_id).status_code == 201


def test_request_body_is_validated(api: WorkspaceApi, setup: Setup) -> None:
    assert api.post("a.researcher", setup.inputs, json={}).status_code == 422
    unknown_field = add(api, setup, setup.public.dataset_id, extra="x")
    assert unknown_field.status_code == 422
    null_note = add(api, setup, setup.public.dataset_id, note=None)
    assert null_note.status_code == 422
    long_note = add(api, setup, setup.public.dataset_id, note="x" * 2001)
    assert long_note.status_code == 422
    nul_note = add(api, setup, setup.public.dataset_id, note="a\u0000b")  # PostgreSQL text cannot hold NUL
    assert nul_note.status_code == 422


# ---------------------------------------------------------------- list


def test_list_is_for_members_only(api: WorkspaceApi, setup: Setup, world: World) -> None:
    add(api, setup, setup.public.dataset_id)
    response = api.get("a.outsider", setup.inputs)
    assert (response.status_code, error_code(response)) == (404, "NOT_FOUND")
    viewer = api.get("a.viewer", setup.inputs)
    assert viewer.status_code == 200
    assert_matches_response("listProjectInputs", 200, viewer.json())
    assert [i["dataset_id"] for i in viewer.json()["items"]] == [str(setup.public.dataset_id)]
    world.projects.archived.add(setup.project_id)
    assert api.get("a.viewer", setup.inputs).status_code == 200  # archived projects stay readable


def test_access_lapses_when_the_grant_is_revoked(api: WorkspaceApi, setup: Setup, world: World) -> None:
    world.grants.grant(USERS["a.researcher"], setup.controlled.dataset_id)
    assert add(api, setup, setup.controlled.dataset_id).status_code == 201
    [item] = api.get("a.researcher", setup.inputs).json()["items"]
    assert item["access_lapsed"] is False

    world.grants.revoke(USERS["a.researcher"], setup.controlled.dataset_id)
    response = api.get("a.researcher", setup.inputs)
    assert_matches_response("listProjectInputs", 200, response.json())
    [item] = response.json()["items"]
    assert item["access_lapsed"] is True
    # computed per caller: the owner organization's member still has access
    [theirs] = api.get("b.researcher", setup.inputs).json()["items"]
    assert theirs["access_lapsed"] is False


def test_access_lapses_when_the_dataset_is_no_longer_public(
    api: WorkspaceApi, setup: Setup, world: World
) -> None:
    assert add(api, setup, setup.public.dataset_id).status_code == 201
    world.catalog.set_access_level(setup.public.dataset_id, "CONTROLLED")
    [item] = api.get("a.researcher", setup.inputs).json()["items"]
    assert (item["access_level"], item["access_lapsed"]) == ("CONTROLLED", True)


def test_newer_version_label_appears_when_a_newer_version_is_published(
    api: WorkspaceApi, setup: Setup, world: World
) -> None:
    assert add(api, setup, setup.public.dataset_id).status_code == 201
    [item] = api.get("a.researcher", setup.inputs).json()["items"]
    assert item["newer_version_label"] is None
    world.catalog.add_version(setup.public, "v2-draft", status="DRAFT")  # drafts do not count
    world.catalog.add_version(setup.public, "v2")
    response = api.get("a.researcher", setup.inputs)
    assert_matches_response("listProjectInputs", 200, response.json())
    [item] = response.json()["items"]
    assert (item["version_label"], item["newer_version_label"]) == ("v1", "v2")


def test_list_orders_by_added_at_and_hides_removed(api: WorkspaceApi, setup: Setup, world: World) -> None:
    world.grants.grant(USERS["a.researcher"], setup.controlled.dataset_id)
    first = add(api, setup, setup.public.dataset_id).json()
    second = add(api, setup, setup.controlled.dataset_id).json()
    items = api.get("a.researcher", setup.inputs).json()["items"]
    assert [i["input_id"] for i in items] == [first["input_id"], second["input_id"]]
    api.delete("a.researcher", f"{setup.inputs}/{first['input_id']}")
    items = api.get("a.researcher", setup.inputs).json()["items"]
    assert [i["input_id"] for i in items] == [second["input_id"]]


# ---------------------------------------------------------------- update


def test_change_version_emits_event(api: WorkspaceApi, setup: Setup, world: World, db: PgUrls) -> None:
    created = add(api, setup, setup.public.dataset_id).json()
    v2 = world.catalog.add_version(setup.public, "v2")
    response = api.patch(
        "a.researcher",
        f"{setup.inputs}/{created['input_id']}",
        json={"dataset_version_id": str(v2.dataset_version_id)},
    )
    assert response.status_code == 200, response.text
    assert_matches_response("updateProjectInput", 200, response.json())
    assert (response.json()["version_label"], response.json()["newer_version_label"]) == ("v2", None)
    assert response.json()["note"] is None

    added, changed = outbox(db)
    assert added["event_type"] == "workspace.input.added.v1"
    assert_valid_event(changed)
    assert changed["event_type"] == "workspace.input.version_changed.v1"
    payload = changed["payload"]
    assert payload["input_id"] == created["input_id"]
    assert payload["dataset_version_id"] == str(v2.dataset_version_id)
    assert payload["version_label"] == "v2"
    assert payload["previous_dataset_version_id"] == str(setup.public_v1.dataset_version_id)
    assert payload["previous_version_label"] == "v1"
    rows = sql(db, "SELECT dataset_version_id FROM workspace.inputs")
    assert [r["dataset_version_id"] for r in rows] == [v2.dataset_version_id]


def test_note_only_update_emits_no_event(api: WorkspaceApi, setup: Setup, db: PgUrls) -> None:
    created = add(api, setup, setup.public.dataset_id, note="first").json()
    path = f"{setup.inputs}/{created['input_id']}"
    response = api.patch("a.researcher", path, json={"note": "second"})
    assert response.status_code == 200
    assert response.json()["note"] == "second"
    cleared = api.patch("a.researcher", path, json={"note": None})
    assert cleared.status_code == 200 and cleared.json()["note"] is None
    same_version = api.patch(
        "a.researcher", path, json={"dataset_version_id": str(setup.public_v1.dataset_version_id)}
    )
    assert same_version.status_code == 200
    assert [e["event_type"] for e in outbox(db)] == ["workspace.input.added.v1"]


def test_update_body_is_validated(api: WorkspaceApi, setup: Setup) -> None:
    created = add(api, setup, setup.public.dataset_id).json()
    path = f"{setup.inputs}/{created['input_id']}"
    assert api.patch("a.researcher", path, json={}).status_code == 422
    assert api.patch("a.researcher", path, json={"dataset_version_id": None}).status_code == 422
    assert api.patch("a.researcher", path, json={"note": "x" * 2001}).status_code == 422


def test_change_version_rechecks_access(api: WorkspaceApi, setup: Setup, world: World) -> None:
    world.grants.grant(USERS["a.researcher"], setup.controlled.dataset_id)
    created = add(api, setup, setup.controlled.dataset_id).json()
    v2 = world.catalog.add_version(setup.controlled, "v2")
    world.grants.revoke(USERS["a.researcher"], setup.controlled.dataset_id)
    response = api.patch(
        "a.researcher",
        f"{setup.inputs}/{created['input_id']}",
        json={"dataset_version_id": str(v2.dataset_version_id)},
    )
    assert (response.status_code, error_code(response)) == (403, "ACCESS_REQUIRED")


def test_change_version_must_stay_within_the_dataset(api: WorkspaceApi, setup: Setup, world: World) -> None:
    created = add(api, setup, setup.public.dataset_id).json()
    path = f"{setup.inputs}/{created['input_id']}"
    other = api.patch(
        "a.researcher", path, json={"dataset_version_id": str(setup.controlled_v1.dataset_version_id)}
    )
    assert (other.status_code, error_code(other)) == (422, "VALIDATION_FAILED")
    draft = world.catalog.add_version(setup.public, "v2", status="DRAFT")
    response = api.patch("a.researcher", path, json={"dataset_version_id": str(draft.dataset_version_id)})
    assert (response.status_code, error_code(response)) == (409, "DATASET_VERSION_NOT_PUBLISHED")


def test_update_requires_a_writing_member(api: WorkspaceApi, setup: Setup, world: World) -> None:
    created = add(api, setup, setup.public.dataset_id).json()
    path = f"{setup.inputs}/{created['input_id']}"
    assert error_code(api.patch("a.viewer", path, json={"note": "x"})) == "FORBIDDEN"
    assert error_code(api.patch("a.outsider", path, json={"note": "x"})) == "FORBIDDEN"
    unknown = api.patch("a.researcher", f"{setup.inputs}/{new_id()}", json={"note": "x"})
    assert (unknown.status_code, error_code(unknown)) == (404, "NOT_FOUND")
    other_project = new_id()
    world.projects.add(other_project, USERS["a.researcher"], "RESEARCHER")
    foreign = api.patch(
        "a.researcher", f"/projects/{other_project}/inputs/{created['input_id']}", json={"note": "x"}
    )
    assert foreign.status_code == 404


# ---------------------------------------------------------------- remove


def test_remove_soft_deletes_and_emits_event(api: WorkspaceApi, setup: Setup, db: PgUrls) -> None:
    created = add(api, setup, setup.public.dataset_id).json()
    path = f"{setup.inputs}/{created['input_id']}"
    assert api.delete("a.viewer", path).status_code == 403
    response = api.delete("a.researcher", path)
    assert response.status_code == 204
    assert_matches_response("removeProjectInput", 204, response.content)
    assert api.get("a.researcher", setup.inputs).json()["items"] == []
    [row] = sql(db, "SELECT removed_at FROM workspace.inputs")
    assert row["removed_at"] is not None

    removed = outbox(db)[-1]
    assert_valid_event(removed)
    assert removed["event_type"] == "workspace.input.removed.v1"
    assert removed["payload"]["input_id"] == created["input_id"]
    assert removed["payload"]["version_label"] == "v1"

    again = api.delete("a.researcher", path)
    assert (again.status_code, error_code(again)) == (404, "NOT_FOUND")
    assert api.patch("a.researcher", path, json={"note": "x"}).status_code == 404


def test_unauthenticated_requests_are_rejected(api: WorkspaceApi, setup: Setup) -> None:
    assert api.get(None, setup.inputs).status_code == 401
    assert api.post(None, setup.inputs, json={"dataset_id": str(setup.public.dataset_id)}).status_code == 401
