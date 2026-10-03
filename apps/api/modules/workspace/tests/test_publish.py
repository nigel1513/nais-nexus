"""Hub publication of outputs through owner review (spec §5.4; openapi requestOutputPublish/listPublishRequests/
decidePublishRequest): one approval slot per owner organization of the lineage inputs plus the lead organization when it
owns none of them (only the lead organization for an output without inputs), each decided by a DATA_STEWARD who is not
the requester; any REJECT rejects, all APPROVE approves and the catalog dataset is then created by the publication job
(CatalogPublishPort) before the output becomes PUBLISHED. A terminal publication failure rejects the request."""

import hashlib
import json
import threading
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest

from api.modules.catalog.public import CatalogPublishRejected, DatasetPolicyView, StorageUnavailable
from api.modules.workspace import MODULE, jobs
from api.modules.workspace.deps import WorkspaceDeps
from api.modules.workspace.schemas import PublishDecisionIn
from api.modules.workspace.service import publish as publish_service
from api.modules.workspace.tests.conftest import STUB_BROKER, WorkspaceApi, World, outbox, sql
from api.modules.workspace.tests.fakes import ORG_A, ORG_B, USERS
from api.platform import clock, ports
from api.platform.db import session_factory
from api.platform.ids import new_id
from api.platform.scheduler import Scheduler
from api.platform.testing.contracts import assert_matches_response, assert_valid_event
from api.platform.testing.fixtures import PgUrls

CSV = b"x,y\n1,2\n"
T = datetime(2026, 10, 2, 6, 0, tzinfo=UTC)


@dataclass
class Setup:
    project_id: UUID
    b_public: DatasetPolicyView  # owner ORG_B
    b_controlled: DatasetPolicyView  # owner ORG_B
    a_public: DatasetPolicyView  # owner ORG_A (the lead organization)


@pytest.fixture
def setup(world: World) -> Setup:
    project_id = new_id()
    world.projects.add(project_id, USERS["a.owner"], "PROJECT_OWNER")  # lead organization: ORG_A (inst-a)
    world.projects.add(project_id, USERS["a.researcher"], "RESEARCHER")
    world.projects.add(project_id, USERS["a.viewer"], "VIEWER")
    world.projects.add(project_id, USERS["b.researcher"], "RESEARCHER")
    b_public = world.catalog.add_dataset("공개 측정", "PUBLIC", owner=ORG_B)
    world.catalog.add_version(b_public, "v1")
    b_controlled = world.catalog.add_dataset("이차전지 충방전 측정", "CONTROLLED", owner=ORG_B)
    world.catalog.add_version(b_controlled, "v2")
    world.grants.grant(USERS["a.researcher"], b_controlled.dataset_id)
    a_public = world.catalog.add_dataset("A 기관 측정", "PUBLIC", owner=ORG_A)
    world.catalog.add_version(a_public, "v3")
    return Setup(project_id, b_public, b_controlled, a_public)


def code(response: Any) -> str:
    return str(response.json()["error"]["code"])


def pin(api: WorkspaceApi, project_id: UUID, dataset: DatasetPolicyView) -> None:
    response = api.post(
        "a.researcher", f"/projects/{project_id}/inputs", json={"dataset_id": str(dataset.dataset_id)}
    )
    assert response.status_code == 201, response.text


def output(
    api: WorkspaceApi,
    world: World,
    project_id: UUID,
    access_level: str = "INTERNAL",
    name: str = "result.csv",
    media_type: str = "text/csv",
    title: str = "고온 구간 평균 용량",
) -> dict[str, Any]:
    """A completed FILE output whose lineage is the project's live inputs."""
    spec = {
        "name": name,
        "size_bytes": len(CSV),
        "sha256": hashlib.sha256(CSV).hexdigest(),
        "media_type": media_type,
    }
    body = {"title": title, "access_level": access_level, "files": [spec]}
    started = api.post("a.researcher", f"/projects/{project_id}/outputs", json=body)
    assert started.status_code == 201, started.text
    output_id = started.json()["output_id"]
    world.storage.put("inst-a", f"workspace/{project_id}/outputs/{output_id}/{name}", CSV)
    done = api.post("a.researcher", f"/projects/{project_id}/outputs/{output_id}/complete")
    assert done.status_code == 200, done.text
    return dict(done.json())


def request(
    api: WorkspaceApi, project_id: UUID, output_id: str, user: str = "a.researcher", **body: Any
) -> Any:
    kwargs = {"json": body} if body else {}
    return api.post(user, f"/projects/{project_id}/outputs/{output_id}/publish-requests", **kwargs)


def decide(api: WorkspaceApi, request_id: str, user: str, decision: str, comment: str | None = None) -> Any:
    body: dict[str, Any] = {"decision": decision}
    if comment is not None:
        body["comment"] = comment
    return api.post(user, f"/publish-requests/{request_id}/decision", json=body)


def output_status(api: WorkspaceApi, project_id: UUID, output_id: str) -> str:
    response = api.get("a.researcher", f"/projects/{project_id}/outputs/{output_id}")
    return str(response.json()["publish_status"])


def publish_messages() -> list[dict[str, Any]]:
    queue = STUB_BROKER.queues.get(jobs.PUBLISH_QUEUE)
    return [json.loads(m) for m in list(queue.queue)] if queue is not None else []


def two_owner_output(api: WorkspaceApi, world: World, s: Setup) -> dict[str, Any]:
    pin(api, s.project_id, s.b_controlled)
    pin(api, s.project_id, s.a_public)
    pin(api, s.project_id, s.b_public)
    return output(api, world, s.project_id, "CONTROLLED")


# ---------------------------------------------------------------- request


def test_request_opens_one_slot_per_input_owner_organization(
    api: WorkspaceApi, setup: Setup, world: World, db: PgUrls
) -> None:
    out = two_owner_output(api, world, setup)
    with clock.frozen(T):
        response = request(api, setup.project_id, out["output_id"])
    assert response.status_code == 201, response.text
    body = response.json()
    assert_matches_response("requestOutputPublish", 201, body)
    assert body["status"] == "PENDING" and body["published_dataset_id"] is None
    assert [(a["organization_id"], a["organization_name"], a["decision"]) for a in body["approvals"]] == [
        (str(ORG_B), "Institute B", None),
        (str(ORG_A), "Institute A", None),
    ]
    assert (body["output_title"], body["created_by"]) == (
        "고온 구간 평균 용량",
        str(USERS["a.researcher"].user_id),
    )
    assert body["project_name"] == world.projects.names[setup.project_id]
    assert output_status(api, setup.project_id, out["output_id"]) == "PENDING"
    [event] = [e for e in outbox(db) if e["event_type"] == "workspace.publish.requested.v1"]
    assert_valid_event(event)
    assert event["payload"] == {
        "project_id": str(setup.project_id),
        "actor_id": str(USERS["a.researcher"].user_id),
        "occurred_at": T.isoformat(),
        "request_id": body["request_id"],
        "output_id": out["output_id"],
        "output_title": "고온 구간 평균 용량",
        "project_name": world.projects.names[setup.project_id],
        "approver_organization_ids": [str(ORG_B), str(ORG_A)],
    }


def test_an_output_without_inputs_needs_the_lead_organization(
    api: WorkspaceApi, setup: Setup, world: World
) -> None:
    out = output(api, world, setup.project_id)
    response = request(api, setup.project_id, out["output_id"], title="업로드 결과 묶음", description="설명")
    assert response.status_code == 201, response.text
    assert [a["organization_id"] for a in response.json()["approvals"]] == [str(ORG_A)]


def test_the_lead_organization_gets_a_slot_when_it_owns_no_input(
    api: WorkspaceApi, setup: Setup, world: World, db: PgUrls
) -> None:
    pin(api, setup.project_id, setup.b_public)
    out = output(api, world, setup.project_id)
    response = request(api, setup.project_id, out["output_id"])
    assert response.status_code == 201, response.text
    assert [a["organization_id"] for a in response.json()["approvals"]] == [str(ORG_B), str(ORG_A)]
    [event] = [e for e in outbox(db) if e["event_type"] == "workspace.publish.requested.v1"]
    assert event["payload"]["approver_organization_ids"] == [str(ORG_B), str(ORG_A)]


def test_a_pending_or_approved_output_cannot_be_requested_again(
    api: WorkspaceApi, setup: Setup, world: World
) -> None:
    pin(api, setup.project_id, setup.b_public)
    out = output(api, world, setup.project_id)
    assert request(api, setup.project_id, out["output_id"]).status_code == 201
    again = request(api, setup.project_id, out["output_id"])
    assert again.status_code == 409 and code(again) == "OUTPUT_PUBLISH_PENDING"
    assert_matches_response("requestOutputPublish", 409, again.json())


def test_a_rejected_output_may_be_requested_again(api: WorkspaceApi, setup: Setup, world: World) -> None:
    pin(api, setup.project_id, setup.b_public)
    out = output(api, world, setup.project_id)
    first = request(api, setup.project_id, out["output_id"]).json()
    assert decide(api, first["request_id"], "b.steward", "REJECT", "개인정보 열 포함").status_code == 200
    assert output_status(api, setup.project_id, out["output_id"]) == "REJECTED"
    second = request(api, setup.project_id, out["output_id"])
    assert second.status_code == 201, second.text
    assert second.json()["request_id"] != first["request_id"]


def test_who_may_request(api: WorkspaceApi, setup: Setup, world: World) -> None:
    out = output(api, world, setup.project_id)
    path_output = out["output_id"]
    viewer = request(api, setup.project_id, path_output, user="a.viewer")
    assert viewer.status_code == 403 and code(viewer) == "FORBIDDEN"
    outsider = request(api, setup.project_id, path_output, user="a.outsider")
    assert outsider.status_code == 404
    missing = request(api, setup.project_id, str(new_id()))
    assert missing.status_code == 404 and code(missing) == "NOT_FOUND"
    world.projects.archived.add(setup.project_id)
    archived = request(api, setup.project_id, path_output)
    assert archived.status_code == 409 and code(archived) == "PROJECT_ARCHIVED"


def test_files_the_catalog_would_refuse_are_rejected(api: WorkspaceApi, setup: Setup, world: World) -> None:
    out = output(api, world, setup.project_id, name="report.pdf", media_type="application/pdf")
    response = request(api, setup.project_id, out["output_id"])
    assert response.status_code == 422 and code(response) == "VALIDATION_FAILED"
    assert response.json()["error"]["details"]["files"] == [
        {"path": "report.pdf", "reason": "FILE_TYPE_NOT_ALLOWED"}
    ]
    assert_matches_response("requestOutputPublish", 422, response.json())


def test_lapsed_input_access_blocks_the_request(api: WorkspaceApi, setup: Setup, world: World) -> None:
    pin(api, setup.project_id, setup.b_controlled)
    out = output(api, world, setup.project_id, "CONTROLLED")
    world.grants.revoke(USERS["a.researcher"], setup.b_controlled.dataset_id)
    response = request(api, setup.project_id, out["output_id"])
    assert response.status_code == 409 and code(response) == "INPUT_ACCESS_LAPSED"


def test_an_input_tightened_above_the_output_level_blocks_the_request(
    api: WorkspaceApi, setup: Setup, world: World
) -> None:
    pin(api, setup.project_id, setup.b_public)
    out = output(api, world, setup.project_id, "PUBLIC")
    world.catalog.set_access_level(setup.b_public.dataset_id, "CONTROLLED")
    world.grants.grant(USERS["a.researcher"], setup.b_public.dataset_id)
    response = request(api, setup.project_id, out["output_id"])
    assert response.status_code == 422 and code(response) == "VALIDATION_FAILED"
    assert response.json()["error"]["details"]["minimum"] == "CONTROLLED"


def test_request_body_is_validated(api: WorkspaceApi, setup: Setup, world: World) -> None:
    out = output(api, world, setup.project_id, title="짧")
    implicit = request(api, setup.project_id, out["output_id"])  # output title too short for a dataset
    assert implicit.status_code == 422 and code(implicit) == "VALIDATION_FAILED"
    for bad in ({"title": "ab"}, {"title": "   "}, {"title": None}, {"extra": 1}, {"description": "a\x00"}):
        response = request(api, setup.project_id, out["output_id"], **bad)
        assert response.status_code == 422, bad
    assert request(api, setup.project_id, out["output_id"], title="충분히 긴 제목").status_code == 201


# ---------------------------------------------------------------- decision


def test_any_reject_rejects_and_requires_a_comment(
    api: WorkspaceApi, setup: Setup, world: World, db: PgUrls
) -> None:
    out = two_owner_output(api, world, setup)
    req = request(api, setup.project_id, out["output_id"]).json()
    first = decide(api, req["request_id"], "b.steward", "APPROVE")
    assert first.status_code == 200, first.text
    assert_matches_response("decidePublishRequest", 200, first.json())
    assert first.json()["status"] == "PENDING"
    assert output_status(api, setup.project_id, out["output_id"]) == "PENDING"
    for comment in (None, "", "   "):
        missing = decide(api, req["request_id"], "a.steward", "REJECT", comment)
        assert missing.status_code == 422 and code(missing) == "VALIDATION_FAILED", comment
        assert_matches_response("decidePublishRequest", 422, missing.json())
    with clock.frozen(T):
        rejected = decide(api, req["request_id"], "a.steward", "REJECT", "원본 데이터 재식별 위험")
    assert rejected.status_code == 200, rejected.text
    body = rejected.json()
    assert body["status"] == "REJECTED"
    slot = body["approvals"][1]
    assert (slot["organization_id"], slot["decision"], slot["comment"], slot["decided_by"]) == (
        str(ORG_A),
        "REJECT",
        "원본 데이터 재식별 위험",
        str(USERS["a.steward"].user_id),
    )
    assert output_status(api, setup.project_id, out["output_id"]) == "REJECTED"
    events = [e for e in outbox(db) if e["event_type"] == "workspace.publish.decided.v1"]
    assert [e["payload"]["request_status"] for e in events] == ["PENDING", "REJECTED"]
    for event in events:
        assert_valid_event(event)
    assert events[1]["payload"] == {
        "project_id": str(setup.project_id),
        "actor_id": str(USERS["a.steward"].user_id),
        "occurred_at": T.isoformat(),
        "request_id": req["request_id"],
        "output_id": out["output_id"],
        "output_title": "고온 구간 평균 용량",
        "organization_id": str(ORG_A),
        "decision": "REJECT",
        "request_status": "REJECTED",
        "requested_by": str(USERS["a.researcher"].user_id),
        "published_dataset_id": None,
        "failure_reason": None,
    }
    assert publish_messages() == []
    late = decide(api, req["request_id"], "b.steward", "APPROVE")
    assert late.status_code == 409 and code(late) == "CONFLICT"


def test_all_approvals_approve_and_queue_the_publication(
    api: WorkspaceApi, setup: Setup, world: World, db: PgUrls
) -> None:
    out = two_owner_output(api, world, setup)
    req = request(api, setup.project_id, out["output_id"]).json()
    assert decide(api, req["request_id"], "a.steward", "APPROVE", "확인함").status_code == 200
    assert publish_messages() == []
    response = decide(api, req["request_id"], "b.steward", "APPROVE")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "APPROVED" and response.json()["published_dataset_id"] is None
    assert output_status(api, setup.project_id, out["output_id"]) == "APPROVED"
    assert [m["args"] for m in publish_messages()] == [[req["request_id"]]]
    again = decide(api, req["request_id"], "b.steward", "APPROVE")
    assert again.status_code == 409 and code(again) == "CONFLICT"
    events = [e for e in outbox(db) if e["event_type"] == "workspace.publish.decided.v1"]
    assert events[-1]["payload"]["request_status"] == "APPROVED"


def test_a_decided_slot_cannot_change(api: WorkspaceApi, setup: Setup, world: World) -> None:
    out = two_owner_output(api, world, setup)
    req = request(api, setup.project_id, out["output_id"]).json()
    assert decide(api, req["request_id"], "b.steward", "APPROVE").status_code == 200
    again = decide(api, req["request_id"], "b.steward", "REJECT", "마음이 바뀜")
    assert again.status_code == 409 and code(again) == "CONFLICT"


def test_only_a_steward_of_a_slot_organization_decides(api: WorkspaceApi, setup: Setup, world: World) -> None:
    pin(api, setup.project_id, setup.b_public)
    out = output(api, world, setup.project_id)
    req = request(api, setup.project_id, out["output_id"]).json()
    member_without_role = decide(api, req["request_id"], "b.researcher", "APPROVE")
    assert member_without_role.status_code == 403 and code(member_without_role) == "FORBIDDEN"
    b_admin = decide(api, req["request_id"], "b.admin", "APPROVE")  # ORG_ADMIN does not decide input slots
    assert b_admin.status_code == 403
    a_admin = decide(api, req["request_id"], "a.admin", "APPROVE")  # the lead slot is a DATA_STEWARD's too
    assert a_admin.status_code == 403
    other_steward = decide(api, req["request_id"], "c.steward", "APPROVE")  # ORG_C has no slot here
    assert other_steward.status_code == 404 and code(other_steward) == "NOT_FOUND"
    member_other_org = decide(api, req["request_id"], "a.researcher", "APPROVE")
    assert member_other_org.status_code == 403
    unknown = decide(api, str(new_id()), "b.steward", "APPROVE")
    assert unknown.status_code == 404
    bad = api.post("b.steward", f"/publish-requests/{req['request_id']}/decision", json={"decision": "MAYBE"})
    assert bad.status_code == 422


def test_the_lead_organization_steward_decides_an_output_without_inputs(
    api: WorkspaceApi, setup: Setup, world: World
) -> None:
    out = output(api, world, setup.project_id)
    req = request(api, setup.project_id, out["output_id"]).json()
    assert decide(api, req["request_id"], "b.steward", "APPROVE").status_code == 404
    assert decide(api, req["request_id"], "a.admin", "APPROVE").status_code == 403
    response = decide(api, req["request_id"], "a.steward", "APPROVE")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "APPROVED"


def test_the_requester_never_decides_their_own_request(api: WorkspaceApi, setup: Setup, world: World) -> None:
    world.projects.add(setup.project_id, USERS["a.steward"], "RESEARCHER")
    pin(api, setup.project_id, setup.b_public)
    out = output(api, world, setup.project_id)
    req = request(api, setup.project_id, out["output_id"], user="a.steward").json()
    assert decide(api, req["request_id"], "b.steward", "APPROVE").status_code == 200
    own = decide(api, req["request_id"], "a.steward", "APPROVE")
    assert own.status_code == 403 and code(own) == "FORBIDDEN"
    assert_matches_response("decidePublishRequest", 403, own.json())
    assert output_status(api, setup.project_id, out["output_id"]) == "PENDING"


def test_concurrent_final_approvals_approve_once(
    api: WorkspaceApi, setup: Setup, world: World, db: PgUrls
) -> None:
    """Two stewards deciding the last two slots at once: the request row lock serializes them; exactly one sees every
    slot approved, so the request is APPROVED once and one publication message is sent."""
    out = two_owner_output(api, world, setup)
    request_id = UUID(request(api, setup.project_id, out["output_id"]).json()["request_id"])
    deps = ports.get(WorkspaceDeps)
    factory = session_factory(db.app)
    approve = PublishDecisionIn(decision="APPROVE")
    first = factory()
    first.begin()
    publish_service.decide(first, deps, USERS["b.steward"], request_id, approve)  # holds the request row lock
    results: list[str] = []

    def second() -> None:
        with factory() as session, session.begin():
            results.append(
                publish_service.decide(session, deps, USERS["a.steward"], request_id, approve).status
            )

    thread = threading.Thread(target=second)
    thread.start()
    thread.join(timeout=1)
    assert thread.is_alive()  # waiting for the lock
    first.commit()
    first.close()
    thread.join(timeout=10)
    assert results == ["APPROVED"]
    [row] = sql(db, "SELECT status, planned_dataset_id FROM workspace.publish_requests")
    assert row["status"] == "APPROVED" and row["planned_dataset_id"] is not None
    assert [m["args"] for m in publish_messages()] == [[str(request_id)]]
    decided = [
        e["payload"]["request_status"]
        for e in outbox(db)
        if e["event_type"] == "workspace.publish.decided.v1"
    ]
    assert decided == ["PENDING", "APPROVED"]


# ---------------------------------------------------------------- list


def test_requester_and_reviewer_lists(api: WorkspaceApi, setup: Setup, world: World) -> None:
    pin(api, setup.project_id, setup.b_public)
    first = request(api, setup.project_id, output(api, world, setup.project_id)["output_id"]).json()
    second = request(api, setup.project_id, output(api, world, setup.project_id)["output_id"]).json()
    decide(api, first["request_id"], "b.steward", "REJECT", "불충분한 설명")

    mine = api.get("a.researcher", "/publish-requests")
    assert mine.status_code == 200, mine.text
    assert_matches_response("listPublishRequests", 200, mine.json())
    assert [i["request_id"] for i in mine.json()["items"]] == [second["request_id"], first["request_id"]]
    pending = api.get("a.researcher", "/publish-requests", params={"status": ["PENDING"]}).json()
    assert [i["request_id"] for i in pending["items"]] == [second["request_id"]]
    both = api.get("a.researcher", "/publish-requests", params={"status": ["PENDING", "REJECTED"]}).json()
    assert len(both["items"]) == 2
    by_project = api.get("a.researcher", "/publish-requests", params={"project_id": str(new_id())}).json()
    assert by_project["items"] == []

    page = api.get("a.researcher", "/publish-requests", params={"limit": 1}).json()
    assert page["page"]["has_more"] and len(page["items"]) == 1
    rest = api.get(
        "a.researcher", "/publish-requests", params={"limit": 1, "cursor": page["page"]["next_cursor"]}
    ).json()
    assert [i["request_id"] for i in rest["items"]] == [first["request_id"]]

    assert api.get("a.outsider", "/publish-requests").json()["items"] == []
    review = api.get("b.steward", "/publish-requests", params={"role": "reviewer"}).json()
    assert [i["request_id"] for i in review["items"]] == [second["request_id"], first["request_id"]]
    lead = api.get("a.steward", "/publish-requests", params={"role": "reviewer"}).json()  # the lead slots
    assert [i["request_id"] for i in lead["items"]] == [second["request_id"], first["request_id"]]
    assert api.get("c.steward", "/publish-requests", params={"role": "reviewer"}).json()["items"] == []
    assert api.get("a.admin", "/publish-requests", params={"role": "reviewer"}).json()["items"] == []
    assert api.get("b.researcher", "/publish-requests", params={"role": "reviewer"}).json()["items"] == []
    assert api.get("b.admin", "/publish-requests", params={"role": "reviewer"}).json()["items"] == []
    assert api.get("a.researcher", "/publish-requests", params={"role": "boss"}).status_code == 422
    assert api.get("a.researcher", "/publish-requests", params={"cursor": "garbage"}).status_code == 422


def test_the_lead_steward_reviews_outputs_without_inputs(
    api: WorkspaceApi, setup: Setup, world: World
) -> None:
    req = request(api, setup.project_id, output(api, world, setup.project_id)["output_id"]).json()
    review = api.get("a.steward", "/publish-requests", params={"role": "reviewer"}).json()
    assert [i["request_id"] for i in review["items"]] == [req["request_id"]]
    assert api.get("a.admin", "/publish-requests", params={"role": "reviewer"}).json()["items"] == []


# ---------------------------------------------------------------- publication


def approved(api: WorkspaceApi, setup: Setup, world: World) -> tuple[dict[str, Any], dict[str, Any]]:
    pin(api, setup.project_id, setup.b_controlled)
    out = output(api, world, setup.project_id, "CONTROLLED")
    req = request(
        api, setup.project_id, out["output_id"], title="파생 측정 데이터", description="요약"
    ).json()
    assert decide(api, req["request_id"], "a.steward", "APPROVE").status_code == 200  # lead organization
    assert decide(api, req["request_id"], "b.steward", "APPROVE").status_code == 200
    return out, req


def test_publication_creates_the_catalog_dataset_and_publishes_the_output(
    api: WorkspaceApi, setup: Setup, world: World, db: PgUrls
) -> None:
    out, req = approved(api, setup, world)
    with clock.frozen(T):
        assert publish_service.publish_approved(UUID(req["request_id"])) == "PUBLISHED"
    [call] = world.publisher.calls
    dataset_id = call["dataset_id"]
    assert call["owner_organization_id"] == ORG_A  # project lead organization
    assert (call["title"], call["description"], call["access_level"]) == (
        "파생 측정 데이터",
        "요약",
        "CONTROLLED",
    )
    assert call["allowed_purposes"] == ["ACADEMIC_RESEARCH"]
    assert (call["created_by"], call["published_by"], call["publisher_organization_id"]) == (
        USERS["a.researcher"].user_id,
        USERS["a.steward"].user_id,  # the lead organization's approving steward, not the last approver
        ORG_A,
    )
    [source] = call["files"]
    assert (source.path, source.storage_org_code, source.media_type) == ("result.csv", "inst-a", "text/csv")
    assert source.storage_key == f"workspace/{setup.project_id}/outputs/{out['output_id']}/result.csv"
    assert "이차전지 충방전 측정@v2" in call["lineage_note"]
    assert str(setup.b_controlled.dataset_id) in call["lineage_note"]
    assert (
        f"organization {ORG_A}" in call["lineage_note"]
        and str(USERS["a.steward"].user_id) in call["lineage_note"]
    )
    assert output_status(api, setup.project_id, out["output_id"]) == "PUBLISHED"
    [listed] = api.get("a.researcher", "/publish-requests").json()["items"]
    assert (listed["status"], listed["published_dataset_id"]) == ("APPROVED", str(dataset_id))
    [activity] = sql(db, "SELECT * FROM workspace.dataset_activity")
    assert (activity["dataset_id"], activity["type"], activity["ref_id"], activity["project_id"]) == (
        dataset_id,
        "OUTPUT_PUBLISHED",
        UUID(out["output_id"]),
        setup.project_id,
    )
    assert (activity["actor_id"], activity["occurred_at"]) == (USERS["a.steward"].user_id, T)
    assert listed["failure_reason"] is None
    assert publish_service.publish_approved(UUID(req["request_id"])) == "SKIPPED"
    assert len(world.publisher.calls) == 1


def test_publication_waits_while_the_catalog_verifies(
    api: WorkspaceApi, setup: Setup, world: World, db: PgUrls
) -> None:
    out, req = approved(api, setup, world)
    world.publisher.status = "DRAFT"
    with clock.frozen(T):
        assert publish_service.publish_approved(UUID(req["request_id"])) == "DRAFT"
    assert output_status(api, setup.project_id, out["output_id"]) == "APPROVED"
    [listed] = api.get("a.researcher", "/publish-requests").json()["items"]
    assert listed["published_dataset_id"] == str(world.publisher.calls[0]["dataset_id"])
    STUB_BROKER.flush_all()
    with clock.frozen(T + timedelta(seconds=30)):
        assert jobs.resend_publications() == 0  # attempted moments ago
    with clock.frozen(T + timedelta(minutes=2)):
        assert jobs.resend_publications() == 1
    assert [m["args"] for m in publish_messages()] == [[req["request_id"]]]
    world.publisher.status = "PUBLISHED"
    assert publish_service.publish_approved(UUID(req["request_id"])) == "PUBLISHED"
    calls = world.publisher.calls
    assert calls[0]["dataset_id"] == calls[1]["dataset_id"]  # the same idempotency key
    assert output_status(api, setup.project_id, out["output_id"]) == "PUBLISHED"
    assert len(sql(db, "SELECT 1 FROM workspace.dataset_activity")) == 1
    with clock.frozen(T + timedelta(hours=1)):
        assert jobs.resend_publications() == 0


def test_storage_outage_releases_the_lease_for_a_retry(api: WorkspaceApi, setup: Setup, world: World) -> None:
    out, req = approved(api, setup, world)
    world.publisher.fail_with = StorageUnavailable("down")
    with clock.frozen(T):
        assert publish_service.publish_approved(UUID(req["request_id"])) == "RETRY"
    world.publisher.fail_with = None
    with clock.frozen(T + timedelta(minutes=2)):
        assert jobs.resend_publications() == 1
        assert publish_service.publish_approved(UUID(req["request_id"])) == "PUBLISHED"


def test_a_lease_held_by_another_worker_is_respected(api: WorkspaceApi, setup: Setup, world: World) -> None:
    _, req = approved(api, setup, world)
    with clock.frozen(T):
        assert publish_service.claim_publication(UUID(req["request_id"])) is not None
        assert publish_service.claim_publication(UUID(req["request_id"])) is None
        assert publish_service.publish_approved(UUID(req["request_id"])) == "SKIPPED"
    with clock.frozen(T + timedelta(minutes=5)):
        assert jobs.resend_publications() == 0  # still leased
    with clock.frozen(T + publish_service.LEASE + timedelta(minutes=1)):
        assert jobs.resend_publications() == 1  # the lease expired (worker died)
    assert world.publisher.calls == []


def assert_failed(
    api: WorkspaceApi, setup: Setup, db: PgUrls, out: dict[str, Any], req: dict[str, Any]
) -> str:
    """The request ended REJECTED by the system with a reason; the output can be requested again."""
    [listed] = [
        i
        for i in api.get("a.researcher", "/publish-requests").json()["items"]
        if i["request_id"] == req["request_id"]
    ]
    assert_matches_response(
        "listPublishRequests", 200, {"items": [listed], "page": {"next_cursor": None, "has_more": False}}
    )
    assert listed["status"] == "REJECTED" and listed["failure_reason"]
    assert output_status(api, setup.project_id, out["output_id"]) == "REJECTED"
    event = [e for e in outbox(db) if e["event_type"] == "workspace.publish.decided.v1"][-1]
    assert_valid_event(event)
    payload = event["payload"]
    assert (payload["decision"], payload["request_status"], payload["organization_id"]) == (
        "REJECT",
        "REJECTED",
        str(ORG_A),
    )
    assert payload["failure_reason"] == listed["failure_reason"]
    assert payload["requested_by"] == str(USERS["a.researcher"].user_id)
    assert event["actor"]["type"] == "SYSTEM"
    with clock.frozen(clock.now() + timedelta(hours=1)):
        assert jobs.resend_publications() == 0
    return str(listed["failure_reason"])


def test_catalog_refusal_rejects_the_request_and_allows_a_new_one(
    api: WorkspaceApi, setup: Setup, world: World, db: PgUrls
) -> None:
    out, req = approved(api, setup, world)
    world.publisher.fail_with = CatalogPublishRejected("the owner organization has no storage configured")
    assert publish_service.publish_approved(UUID(req["request_id"])) == "FAILED"
    reason = assert_failed(api, setup, db, out, req)
    assert "storage" in reason
    world.publisher.fail_with = None
    again = request(api, setup.project_id, out["output_id"])
    assert again.status_code == 201, again.text
    second = again.json()
    assert second["failure_reason"] is None
    assert decide(api, second["request_id"], "a.steward", "APPROVE").status_code == 200
    assert decide(api, second["request_id"], "b.steward", "APPROVE").status_code == 200
    assert publish_service.publish_approved(UUID(second["request_id"])) == "PUBLISHED"
    first_call, second_call = world.publisher.calls
    assert first_call["dataset_id"] != second_call["dataset_id"]  # a fresh planned dataset id
    assert output_status(api, setup.project_id, out["output_id"]) == "PUBLISHED"


def test_failed_verification_rejects_the_request(
    api: WorkspaceApi, setup: Setup, world: World, db: PgUrls
) -> None:
    out, req = approved(api, setup, world)
    world.publisher.status = "FAILED"
    assert publish_service.publish_approved(UUID(req["request_id"])) == "FAILED"
    assert (
        assert_failed(api, setup, db, out, req)
        == "카탈로그 파일 검증에 실패했습니다. 산출물 파일을 확인한 뒤 다시 요청하세요."
    )
    [row] = sql(db, "SELECT publication_status, published_dataset_id FROM workspace.publish_requests")
    assert row["publication_status"] == "FAILED" and row["published_dataset_id"] is not None


def test_repeated_retryable_failures_end_in_rejection(
    api: WorkspaceApi, setup: Setup, world: World, db: PgUrls
) -> None:
    out, req = approved(api, setup, world)
    world.publisher.fail_with = StorageUnavailable("down")
    at = T
    for _ in range(publish_service.MAX_FAILURES - 1):
        with clock.frozen(at):
            assert publish_service.publish_approved(UUID(req["request_id"])) == "RETRY"
        at += timedelta(minutes=2)
    assert output_status(api, setup.project_id, out["output_id"]) == "APPROVED"
    with clock.frozen(at):
        assert publish_service.publish_approved(UUID(req["request_id"])) == "FAILED"
    assert "attempts" in assert_failed(api, setup, db, out, req)


def decided_events(db: PgUrls) -> list[dict[str, Any]]:
    return [e for e in outbox(db) if e["event_type"] == "workspace.publish.decided.v1"]


def test_a_stale_worker_cannot_reject_a_published_request(
    api: WorkspaceApi, setup: Setup, world: World, db: PgUrls
) -> None:
    out, req = approved(api, setup, world)
    request_id = UUID(req["request_id"])
    with clock.frozen(T):
        stale = publish_service.claim_publication(request_id)  # a worker that stalls past its lease
    assert stale is not None
    with clock.frozen(T + publish_service.LEASE + timedelta(minutes=1)):
        assert publish_service.publish_approved(request_id) == "PUBLISHED"
    before = len(decided_events(db))
    publish_service._fail(stale, "late failure from the stalled worker", None)
    assert output_status(api, setup.project_id, out["output_id"]) == "PUBLISHED"
    [listed] = api.get("a.researcher", "/publish-requests").json()["items"]
    assert (listed["status"], listed["failure_reason"]) == ("APPROVED", None)
    assert len(decided_events(db)) == before  # no system REJECT for the requester


def test_a_stale_worker_cannot_reject_a_publication_leased_by_another(
    api: WorkspaceApi, setup: Setup, world: World, db: PgUrls
) -> None:
    out, req = approved(api, setup, world)
    request_id = UUID(req["request_id"])
    with clock.frozen(T):
        stale = publish_service.claim_publication(request_id)
    with clock.frozen(T + publish_service.LEASE + timedelta(minutes=1)):
        fresh = publish_service.claim_publication(
            request_id
        )  # the lease expired; another worker holds it now
    assert stale is not None and fresh is not None
    before = len(decided_events(db))
    publish_service._fail(stale, "late failure from the stalled worker", None)
    [row] = sql(
        db, "SELECT status, publication_status, publication_claimed_until FROM workspace.publish_requests"
    )
    assert (row["status"], row["publication_status"]) == ("APPROVED", "PENDING")
    assert row["publication_claimed_until"] == fresh["publication_claimed_until"]
    assert output_status(api, setup.project_id, out["output_id"]) == "APPROVED"
    assert len(decided_events(db)) == before
    publish_service._fail(fresh, "카탈로그가 공개를 거부했습니다: the lease holder fails", None)
    assert assert_failed(api, setup, db, out, req).endswith("the lease holder fails")


def test_publication_never_loosens_the_inputs_current_level(
    api: WorkspaceApi, setup: Setup, world: World
) -> None:
    _, req = approved(api, setup, world)
    world.catalog.set_access_level(setup.b_controlled.dataset_id, "SENSITIVE")
    assert publish_service.publish_approved(UUID(req["request_id"])) == "PUBLISHED"
    assert world.publisher.calls[0]["access_level"] == "SENSITIVE"


def test_publication_worker_registration() -> None:
    scheduler = Scheduler()
    jobs.register_worker(jobs.run_recipe_actor.broker, scheduler)
    assert "workspace.resend_publications" in scheduler.job_names
    assert (jobs.publish_output_actor.actor_name, jobs.publish_output_actor.queue_name) == (
        "workspace.publish_output",
        "workspace_publish",
    )
    assert jobs.PUBLISH_QUEUE not in MODULE.dedicated_queues  # general pool, not behind recipe runs
    assert publish_service.LEASE.total_seconds() * 1000 > jobs.PUBLISH_TIME_LIMIT_MS


def test_the_actor_runs_one_publication(api: WorkspaceApi, setup: Setup, world: World) -> None:
    out, req = approved(api, setup, world)
    jobs.publish_output_actor.fn(req["request_id"])
    assert output_status(api, setup.project_id, out["output_id"]) == "PUBLISHED"


def test_database_rejects_inconsistent_requests(
    api: WorkspaceApi, setup: Setup, world: World, db: PgUrls
) -> None:
    from sqlalchemy.exc import IntegrityError

    pin(api, setup.project_id, setup.b_public)
    out = output(api, world, setup.project_id)
    req = request(api, setup.project_id, out["output_id"]).json()
    with pytest.raises(IntegrityError):  # a second open request for the same output
        sql(
            db,
            "INSERT INTO workspace.publish_requests (request_id, output_id, project_id, status, title, description,"
            " created_by, created_at, lead_organization_id) VALUES (:r, :o, :p, 'PENDING', 'title', '', :u, now(), :u)",
            r=new_id(),
            o=out["output_id"],
            p=setup.project_id,
            u=USERS["a.researcher"].user_id,
        )
    with pytest.raises(IntegrityError):  # REJECT without a comment
        sql(
            db,
            "UPDATE workspace.publish_approvals SET decision = 'REJECT', decided_by = :u, decided_at = now()"
            " WHERE request_id = :r",
            u=USERS["b.steward"].user_id,
            r=req["request_id"],
        )
    with pytest.raises(IntegrityError):  # FAILED publication on a request that is not REJECTED
        sql(
            db,
            "UPDATE workspace.publish_requests SET status = 'APPROVED', planned_dataset_id = :d,"
            " publication_status = 'FAILED', publication_error = 'x' WHERE request_id = :r",
            d=new_id(),
            r=req["request_id"],
        )
    with pytest.raises(IntegrityError):  # APPROVED without a planned dataset
        sql(
            db,
            "UPDATE workspace.publish_requests SET status = 'APPROVED' WHERE request_id = :r",
            r=req["request_id"],
        )
