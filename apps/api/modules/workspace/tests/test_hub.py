"""Data-Hub reads (spec §4; openapi getHubOverview/listDatasetProjects/listDatasetActivity) and the event
handlers that feed them (handlers.py)."""

from contextlib import nullcontext
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from api.modules.catalog.public import DatasetPolicyView
from api.modules.workspace.tests.conftest import WorkspaceApi, World, sql
from api.modules.workspace.tests.fakes import ORG_A, ORG_B, T0, USERS
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.db import session_factory
from api.platform.event_bus import HandlerRegistry, registry
from api.platform.events import EventActor
from api.platform.ids import new_id
from api.platform.outbox import outbox
from api.platform.relay import RelayResult, dispatch_batch
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls

NOW = T0 + timedelta(days=30)
WORKSPACE_EVENTS = (
    "catalog.dataset.version_published.v1",
    "catalog.dataset.metadata_changed.v1",
    "catalog.dataset.policy_changed.v1",
    "catalog.dataset.access_level_changed.v1",
    "readiness.validation.completed.v1",
    "governance.access.requested.v1",
    "workspace.input.added.v1",
    "workspace.comment.added.v1",
)


# ---------------------------------------------------------------- helpers


def workspace_registry() -> HandlerRegistry:
    local = HandlerRegistry()
    for event_type in WORKSPACE_EVENTS:
        for subscription in registry.handlers_for(event_type):
            if subscription.name.startswith("api.modules.workspace."):
                local.subscribe(event_type)(subscription.handler)
    return local


def emit(
    db: PgUrls,
    event_type: str,
    payload: dict[str, Any],
    user: CurrentUser | None = None,
    at: datetime | None = None,
) -> None:
    actor = EventActor.for_user(user) if user else EventActor.system()
    with clock.frozen(at) if at else nullcontext(), session_factory(db.app)() as session, session.begin():
        outbox.write(session, event_type, payload, actor)


def relay(db: PgUrls) -> RelayResult:
    result = dispatch_batch(session_factory(db.app), workspace_registry())
    assert (result.retried, result.dead) == (0, 0)
    return result


def requested(dataset: DatasetPolicyView) -> dict[str, Any]:
    return {
        "access_request_id": str(new_id()),
        "dataset_id": str(dataset.dataset_id),
        "project_id": str(new_id()),
        "requester_user_id": str(USERS["a.researcher"].user_id),
        "requester_organization_id": str(ORG_A),
        "owner_organization_id": str(dataset.owner_organization_id),
        "purpose": "ACADEMIC_RESEARCH",
        "operations": ["READ"],
        "requested_days": 30,
        "resubmission": False,
        "dataset_title": dataset.title,
        "project_name": "p",
    }


def pin(
    db: PgUrls, project_id: UUID, dataset: DatasetPolicyView, *, removed: bool = False, at: datetime = T0
) -> None:
    sql(
        db,
        "INSERT INTO workspace.inputs (input_id, project_id, dataset_id, dataset_version_id, added_by, added_at,"
        " removed_at) VALUES (:i, :p, :d, :v, :u, :at, CASE WHEN :removed THEN now() END)",
        i=new_id(),
        p=project_id,
        d=dataset.dataset_id,
        v=new_id(),
        u=USERS["a.researcher"].user_id,
        at=at,
        removed=removed,
    )


def overview(api: WorkspaceApi, user: str) -> dict[str, Any]:
    with clock.frozen(NOW):
        response = api.get(user, "/hub/overview")
    assert response.status_code == 200, response.text
    assert_matches_response("getHubOverview", 200, response.json())
    body: dict[str, Any] = response.json()
    return body


def titles(cards: list[dict[str, Any]]) -> list[tuple[str, int | None]]:
    return [(c["title"], c["metric"]) for c in cards]


# ---------------------------------------------------------------- overview


def test_overview_shows_only_visible_active_datasets(api: WorkspaceApi, world: World) -> None:
    public = world.catalog.add_dataset("공개", "PUBLIC", subjects=("재료",))
    world.catalog.add_version(public, "v1")
    internal = world.catalog.add_dataset("내부", "INTERNAL")
    world.catalog.add_version(internal, "v1")
    withdrawn = world.catalog.add_dataset("철회", "PUBLIC")
    world.catalog.add_version(withdrawn, "v1")
    world.catalog.withdraw(withdrawn.dataset_id)
    world.catalog.add_dataset("미발행", "CONTROLLED")

    outsider = overview(api, "a.researcher")
    assert titles(outsider["rails"]["recent"]) == [("공개", None)]
    [card] = outsider["rails"]["recent"]
    assert card["owner_organization_name"] == "Institute B"
    assert card["subject_labels"] == ["재료"]
    assert card["readiness_overall"] == "PASS"
    assert outsider["rails"]["trending"] == outsider["rails"]["most_used"] == []
    assert outsider["organizations"] == [
        {
            "organization_id": str(ORG_B),
            "name": "Institute B",
            "dataset_count": 1,
            "public_count": 1,
            "controlled_count": 0,
            "last_updated_at": T0.isoformat().replace("+00:00", "Z"),
        }
    ]
    assert world.catalog.summary_calls == 1  # one batched catalog call, no per-dataset lookups

    owner = overview(api, "b.researcher")
    assert [c["title"] for c in owner["rails"]["recent"]] == ["내부", "공개"]  # newest publication first
    [org] = owner["organizations"]
    assert (org["dataset_count"], org["public_count"], org["controlled_count"]) == (3, 1, 1)


def test_rails_hold_at_most_six(api: WorkspaceApi, world: World) -> None:
    for i in range(8):
        ds = world.catalog.add_dataset(f"d{i}", "PUBLIC")
        world.catalog.add_version(ds, "v1")
    recent = overview(api, "a.researcher")["rails"]["recent"]
    assert [c["title"] for c in recent] == ["d7", "d6", "d5", "d4", "d3", "d2"]


def test_most_used_counts_live_inputs(api: WorkspaceApi, world: World, db: PgUrls) -> None:
    once = world.catalog.add_dataset("한 번", "PUBLIC")
    world.catalog.add_version(once, "v1")
    twice = world.catalog.add_dataset("두 번", "PUBLIC")
    world.catalog.add_version(twice, "v1")
    hidden = world.catalog.add_dataset("내부", "INTERNAL")
    world.catalog.add_version(hidden, "v1")
    unused = world.catalog.add_dataset("미사용", "PUBLIC")
    world.catalog.add_version(unused, "v1")
    pin(db, new_id(), once)
    pin(db, new_id(), once, removed=True)
    pin(db, new_id(), twice)
    pin(db, new_id(), twice)
    for _ in range(3):
        pin(db, new_id(), hidden)
    assert titles(overview(api, "a.researcher")["rails"]["most_used"]) == [("두 번", 2), ("한 번", 1)]


def test_trending_counts_access_requests_of_the_last_seven_days(
    api: WorkspaceApi, world: World, db: PgUrls
) -> None:
    hot = world.catalog.add_dataset("요청 많음", "CONTROLLED")
    world.catalog.add_version(hot, "v1")
    warm = world.catalog.add_dataset("요청 하나", "CONTROLLED")
    world.catalog.add_version(warm, "v1")
    stale = world.catalog.add_dataset("오래된 요청", "CONTROLLED")
    world.catalog.add_version(stale, "v1")
    world.catalog.add_dataset("요청 없음", "CONTROLLED")
    for _ in range(3):
        emit(db, "governance.access.requested.v1", requested(hot), at=NOW - timedelta(days=1))
    emit(db, "governance.access.requested.v1", requested(warm), at=NOW - timedelta(days=6))
    emit(db, "governance.access.requested.v1", requested(stale), at=NOW - timedelta(days=8))
    relay(db)
    assert titles(overview(api, "a.researcher")["rails"]["trending"]) == [("요청 많음", 3), ("요청 하나", 1)]


def test_access_request_handler_is_idempotent(api: WorkspaceApi, world: World, db: PgUrls) -> None:
    ds = world.catalog.add_dataset("요청", "CONTROLLED")
    world.catalog.add_version(ds, "v1")
    emit(db, "governance.access.requested.v1", requested(ds), at=NOW - timedelta(hours=1))
    relay(db)
    sql(db, "UPDATE platform.outbox_events SET dispatched_at = NULL")  # redelivery
    relay(db)
    assert titles(overview(api, "a.researcher")["rails"]["trending"]) == [("요청", 1)]


def test_overview_requires_sign_in(api: WorkspaceApi, world: World) -> None:
    assert api.get(None, "/hub/overview").status_code == 401


# ---------------------------------------------------------------- dataset projects


def test_dataset_projects_lists_my_projects_and_counts_the_rest(
    api: WorkspaceApi, world: World, db: PgUrls
) -> None:
    ds = world.catalog.add_dataset("공개", "PUBLIC")
    world.catalog.add_version(ds, "v1")
    mine_old, mine_new, foreign, former = new_id(), new_id(), new_id(), new_id()
    world.projects.add(mine_old, USERS["a.researcher"], "VIEWER")
    world.projects.add(mine_new, USERS["a.researcher"], "RESEARCHER")
    world.projects.names[mine_new] = "전극 소재 열화 분석"
    world.projects.add(foreign, USERS["b.researcher"], "PROJECT_OWNER")
    world.projects.add(former, USERS["a.researcher"], "RESEARCHER")
    pin(db, mine_old, ds, at=T0)
    pin(db, mine_new, ds, at=T0 + timedelta(days=1))
    pin(db, foreign, ds)
    pin(db, former, ds, removed=True)

    response = api.get("a.researcher", f"/datasets/{ds.dataset_id}/projects")
    assert response.status_code == 200, response.text
    assert_matches_response("listDatasetProjects", 200, response.json())
    body = response.json()
    assert [i["project_id"] for i in body["items"]] == [str(mine_new), str(mine_old)]
    assert body["items"][0]["name"] == "전극 소재 열화 분석"
    assert body["items"][0]["lead_organization_name"] == "Institute A"
    assert body["hidden_count"] == 1

    other = api.get("b.researcher", f"/datasets/{ds.dataset_id}/projects").json()
    assert ([i["project_id"] for i in other["items"]], other["hidden_count"]) == ([str(foreign)], 2)


def test_dataset_projects_of_invisible_dataset_is_not_found(api: WorkspaceApi, world: World) -> None:
    internal = world.catalog.add_dataset("내부", "INTERNAL")
    world.catalog.add_version(internal, "v1")
    assert api.get("a.researcher", f"/datasets/{internal.dataset_id}/projects").status_code == 404
    assert api.get("a.researcher", f"/datasets/{new_id()}/projects").status_code == 404
    assert api.get("a.researcher", f"/datasets/{internal.dataset_id}/activity").status_code == 404


# ---------------------------------------------------------------- dataset activity


def test_activity_is_built_from_events_and_hides_foreign_projects(
    api: WorkspaceApi, world: World, db: PgUrls
) -> None:
    ds = world.catalog.add_dataset("공개", "PUBLIC")
    v1 = world.catalog.add_version(ds, "v1")
    mine, foreign = new_id(), new_id()
    world.projects.add(mine, USERS["a.researcher"], "RESEARCHER")
    world.projects.names[mine] = "내 과제"
    world.projects.add(foreign, USERS["b.researcher"], "RESEARCHER")
    steward = USERS["b.steward"]
    base = {"dataset_id": str(ds.dataset_id), "owner_organization_id": str(ORG_B)}
    emit(
        db,
        "catalog.dataset.version_published.v1",
        base
        | {
            "dataset_version_id": str(v1.dataset_version_id),
            "version_label": "v1",
            "file_count": 1,
            "total_bytes": 10,
            "manifest_sha256": "a" * 64,
        },
        steward,
        at=T0,
    )
    emit(
        db,
        "catalog.dataset.metadata_changed.v1",
        base | {"changed_fields": ["title"]},
        steward,
        at=T0 + timedelta(hours=1),
    )
    emit(
        db,
        "catalog.dataset.access_level_changed.v1",
        base | {"previous_access_level": "CONTROLLED", "access_level": "PUBLIC"},
        steward,
        at=T0 + timedelta(hours=2),
    )
    for i, project in enumerate((mine, foreign)):
        user = USERS["a.researcher"] if project == mine else USERS["b.researcher"]
        emit(
            db,
            "workspace.input.added.v1",
            input_payload(ds, v1.dataset_version_id, project, user),
            user,
            at=T0 + timedelta(hours=3 + i),
        )
    emit(
        db,
        "workspace.comment.added.v1",
        {
            "project_id": None,
            "actor_id": str(USERS["a.researcher"].user_id),
            "occurred_at": (T0 + timedelta(hours=5)).isoformat(),
            "thread_id": str(new_id()),
            "thread_title": "단위 질문",
            "scope": "DATASET",
            "target_id": str(ds.dataset_id),
            "comment_id": str(new_id()),
            "new_thread": True,
            "owner_organization_id": str(ORG_B),
        },
        USERS["a.researcher"],
        at=T0 + timedelta(hours=5),
    )
    relay(db)

    response = api.get("a.researcher", f"/datasets/{ds.dataset_id}/activity")
    assert response.status_code == 200, response.text
    assert_matches_response("listDatasetActivity", 200, response.json())
    items = response.json()["items"]
    assert [(i["type"], i["label"]) for i in items] == [
        ("DISCUSSION_STARTED", "단위 질문"),
        ("USED_IN_PROJECT", None),
        ("USED_IN_PROJECT", "내 과제"),
        ("POLICY_CHANGED", "PUBLIC"),
        ("METADATA_CHANGED", None),
        ("VERSION_PUBLISHED", "v1"),
    ]
    foreign_use, my_use = items[1], items[2]
    assert (foreign_use["project_id"], foreign_use["ref_id"], foreign_use["actor_display_name"]) == (
        None,
        None,
        None,
    )
    assert (my_use["project_id"], my_use["ref_id"]) == (str(mine), str(mine))
    assert my_use["actor_display_name"] == "A Researcher"
    assert items[-1]["ref_id"] == str(v1.dataset_version_id)
    assert items[-1]["actor_display_name"] == "B Steward"

    page = api.get("a.researcher", f"/datasets/{ds.dataset_id}/activity?limit=4").json()
    assert page["page"]["has_more"] is True
    rest = api.get(
        "a.researcher", f"/datasets/{ds.dataset_id}/activity?limit=4&cursor={page['page']['next_cursor']}"
    ).json()
    assert [i["activity_id"] for i in page["items"] + rest["items"]] == [i["activity_id"] for i in items]


def test_project_threads_do_not_become_dataset_activity(api: WorkspaceApi, world: World, db: PgUrls) -> None:
    ds = world.catalog.add_dataset("공개", "PUBLIC")
    world.catalog.add_version(ds, "v1")
    project_id = new_id()
    world.projects.add(project_id, USERS["a.researcher"], "RESEARCHER")
    assert (
        api.post(
            "a.researcher",
            "/threads",
            json={"scope": "PROJECT", "target_id": str(project_id), "title": "t", "body": "b"},
        ).status_code
        == 201
    )
    relay(db)
    assert api.get("a.researcher", f"/datasets/{ds.dataset_id}/activity").json()["items"] == []


def input_payload(
    ds: DatasetPolicyView, version_id: UUID, project_id: UUID, user: CurrentUser
) -> dict[str, Any]:
    return {
        "project_id": str(project_id),
        "actor_id": str(user.user_id),
        "occurred_at": T0.isoformat(),
        "input_id": str(new_id()),
        "dataset_id": str(ds.dataset_id),
        "dataset_title": ds.title,
        "dataset_version_id": str(version_id),
        "version_label": "v1",
        "owner_organization_id": str(ds.owner_organization_id),
    }
