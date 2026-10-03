"""Evidence capture (handlers.py): workspace activity and governance download/access decisions become per-researcher,
per-day (Asia/Seoul) evidence rows holding labels only; each event is recorded once."""

from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID

from api.modules.notes import handlers
from api.modules.notes.tests.conftest import sql
from api.modules.notes.tests.fakes import ORG_A, ORG_B, USERS
from api.platform import clock
from api.platform.db import session_factory
from api.platform.event_bus import HandlerRegistry, registry
from api.platform.events import EventActor, EventEnvelope
from api.platform.generated.event_types import EventType
from api.platform.ids import new_id
from api.platform.outbox import outbox
from api.platform.relay import dispatch_batch
from api.platform.testing.fixtures import PgUrls

AT = datetime(2026, 10, 1, 16, 30, tzinfo=UTC)  # 2026-10-02 01:30 KST
RECORDER = USERS["a.recorder"]
PROJECT = new_id()


def notes_registry() -> HandlerRegistry:
    local = HandlerRegistry()
    for kind in EventType:
        for subscription in registry.handlers_for(kind.value):
            if subscription.name.startswith("api.modules.notes."):
                local.subscribe(kind)(subscription.handler)
    return local


def emit(db: PgUrls, kind: EventType, payload: dict[str, Any], actor: EventActor | None = None) -> None:
    actor = actor or EventActor.for_user(RECORDER)
    with clock.frozen(AT), session_factory(db.app)() as session, session.begin():
        outbox.write(session, kind, payload, actor)


def relay(db: PgUrls) -> None:
    result = dispatch_batch(session_factory(db.app), notes_registry())
    assert (result.retried, result.dead) == (0, 0)


def evidence(db: PgUrls) -> list[dict[str, Any]]:
    return sql(
        db,
        "SELECT project_id, actor_id, note_date, type, ref_id, label, at, payload FROM notes.evidence ORDER BY type",
    )


def base(**extra: Any) -> dict[str, Any]:
    return {
        "project_id": str(PROJECT),
        "actor_id": str(RECORDER.user_id),
        "occurred_at": AT.isoformat(),
        **extra,
    }


def input_payload(**extra: Any) -> dict[str, Any]:
    return base(
        input_id=str(new_id()),
        dataset_id=str(new_id()),
        dataset_title="전극 열화 측정",
        dataset_version_id=str(new_id()),
        version_label="v2",
        owner_organization_id=str(ORG_B),
        **extra,
    )


def test_workspace_events_become_labelled_evidence(db: PgUrls) -> None:
    recipe_id, run_id, output_id = new_id(), new_id(), new_id()
    added = input_payload()
    emit(db, EventType.WORKSPACE_INPUT_ADDED_V1, added)
    emit(
        db,
        EventType.WORKSPACE_INPUT_VERSION_CHANGED_V1,
        input_payload(previous_dataset_version_id=str(new_id()), previous_version_label="v1"),
    )
    emit(
        db,
        EventType.WORKSPACE_RECIPE_SAVED_V1,
        base(
            recipe_id=str(recipe_id),
            recipe_name="고온 구간 평균 용량",
            recipe_version=3,
            input_ids=[],
            step_count=4,
        ),
    )
    run = base(
        run_id=str(run_id), recipe_id=str(recipe_id), recipe_name="고온 구간 평균 용량", recipe_version=3
    )
    emit(
        db,
        EventType.WORKSPACE_RUN_SUCCEEDED_V1,
        dict(run, input_rows=182340, output_rows=24, output_id=str(output_id)),
    )
    emit(
        db,
        EventType.WORKSPACE_RUN_FAILED_V1,
        dict(run, run_id=str(new_id()), error="COLUMN_NOT_FOUND: column 'cap' missing near value 3.141"),
    )
    emit(
        db,
        EventType.WORKSPACE_OUTPUT_CREATED_V1,
        base(
            output_id=str(output_id),
            output_title="고온 평균 용량표",
            kind="DERIVED_DATASET",
            access_level="CONTROLLED",
            run_id=str(run_id),
            lineage_dataset_version_ids=[],
        ),
    )
    emit(
        db,
        EventType.WORKSPACE_PUBLISH_REQUESTED_V1,
        base(
            request_id=str(new_id()),
            output_id=str(output_id),
            output_title="고온 평균 용량표",
            project_name="전극 소재 열화 분석",
            approver_organization_ids=[str(ORG_A)],
        ),
    )
    relay(db)
    rows = evidence(db)
    assert {(r["type"], r["label"]) for r in rows} == {
        ("INPUT_ADDED", "전극 열화 측정@v2"),
        ("INPUT_VERSION_CHANGED", "전극 열화 측정@v1 → v2"),
        ("RECIPE_SAVED", "고온 구간 평균 용량@3 · 4단계"),
        ("RUN_SUCCEEDED", "고온 구간 평균 용량@3 · 182,340행 → 24행"),
        ("RUN_FAILED", "고온 구간 평균 용량@3 · COLUMN_NOT_FOUND"),
        ("OUTPUT_CREATED", "고온 평균 용량표"),
        ("PUBLISH_REQUESTED", "고온 평균 용량표"),
    }
    for r in rows:
        assert (r["project_id"], r["actor_id"]) == (PROJECT, RECORDER.user_id)
        assert r["note_date"] == date(2026, 10, 2)  # Asia/Seoul
        assert r["at"] == AT
        assert r["payload"] == {"organization_id": str(RECORDER.organization_id)}
    [input_row] = [r for r in rows if r["type"] == "INPUT_ADDED"]
    assert input_row["ref_id"] == UUID(added["input_id"])


def test_same_event_twice_is_one_row(db: PgUrls) -> None:
    emit(db, EventType.WORKSPACE_INPUT_ADDED_V1, input_payload())
    [envelope] = [
        EventEnvelope.model_validate(r["envelope"])
        for r in sql(db, "SELECT envelope FROM platform.outbox_events")
    ]
    for _ in range(2):
        with session_factory(db.app)() as session, session.begin():
            handlers.on_input_added(session, envelope)
    assert len(evidence(db)) == 1
    relay(db)  # the relay delivers it a third time
    assert len(evidence(db)) == 1


def test_injected_payload_keys_are_not_stored(db: PgUrls) -> None:
    """A producer bug adding data values to a payload must not carry them into notes."""
    envelope = EventEnvelope(
        event_id=new_id(),
        event_type=EventType.WORKSPACE_RUN_SUCCEEDED_V1.value,
        occurred_at=AT,
        producer="workspace",
        correlation_id=new_id(),
        actor=EventActor.for_user(RECORDER),
        payload=base(
            run_id=str(new_id()),
            recipe_id=str(new_id()),
            recipe_name="레시피",
            recipe_version=1,
            input_rows=10,
            output_rows=2,
            output_id=str(new_id()),
            rows=[["SECRET-ROW", 1]],
            file_content="SECRET-FILE",
            preview={"cells": ["SECRET-CELL"]},
        ),
    )
    with session_factory(db.app)() as session, session.begin():
        handlers.on_run_succeeded(session, envelope)
    dumped = str(sql(db, "SELECT * FROM notes.evidence"))
    assert "SECRET" not in dumped
    assert len(evidence(db)) == 1


def test_governance_downloads_and_access_decisions(db: PgUrls) -> None:
    reviewer = EventActor(type="USER", user_id=USERS["b.witness"].user_id, organization_id=ORG_B)
    request_id, version_id = new_id(), new_id()
    emit(
        db,
        EventType.GOVERNANCE_DOWNLOAD_AUTHORIZED_V1,
        {
            "dataset_id": str(new_id()),
            "dataset_version_id": str(version_id),
            "owner_organization_id": str(ORG_B),
            "project_id": str(PROJECT),
            "access_grant_id": str(new_id()),
            "basis": "GRANT",
            "file_ids": [str(new_id()), str(new_id())],
            "ttl_seconds": 300,
            "policy_version": "1",
        },
    )
    emit(  # a download outside any project is no project's evidence
        db,
        EventType.GOVERNANCE_DOWNLOAD_AUTHORIZED_V1,
        {
            "dataset_id": str(new_id()),
            "dataset_version_id": str(new_id()),
            "owner_organization_id": str(ORG_B),
            "project_id": None,
            "access_grant_id": None,
            "basis": "PUBLIC",
            "file_ids": [],
            "ttl_seconds": 300,
            "policy_version": "1",
        },
    )
    emit(
        db,
        EventType.GOVERNANCE_ACCESS_APPROVED_V1,
        {
            "access_request_id": str(request_id),
            "access_grant_id": str(new_id()),
            "dataset_id": str(new_id()),
            "project_id": str(PROJECT),
            "subject_user_id": str(RECORDER.user_id),
            "owner_organization_id": str(ORG_B),
            "operations": ["READ"],
            "valid_from": AT.isoformat(),
            "expires_at": AT.isoformat(),
            "policy_version": "1",
            "reviewer_user_id": str(reviewer.user_id),
        },
        reviewer,
    )
    emit(
        db,
        EventType.GOVERNANCE_ACCESS_REJECTED_V1,
        {
            "access_request_id": str(new_id()),
            "dataset_id": str(new_id()),
            "project_id": str(PROJECT),
            "requester_user_id": str(RECORDER.user_id),
            "owner_organization_id": str(ORG_B),
            "reviewer_user_id": str(reviewer.user_id),
            "reason": "SECRET free text of the reviewer",
        },
        reviewer,
    )
    relay(db)
    rows = evidence(db)
    assert [(r["type"], r["label"], r["actor_id"]) for r in rows] == [
        ("ACCESS_DECIDED", "데이터 접근 승인", RECORDER.user_id),
        ("ACCESS_DECIDED", "데이터 접근 반려", RECORDER.user_id),
        ("DATASET_DOWNLOADED", "데이터셋 파일 2개 다운로드", RECORDER.user_id),
    ]
    assert "SECRET" not in str(rows)
    decided = [r for r in rows if r["type"] == "ACCESS_DECIDED"]
    assert request_id in {r["ref_id"] for r in decided}
    assert all(r["payload"] == {} for r in decided)  # the reviewer's organization is not the researcher's
    [download] = [r for r in rows if r["type"] == "DATASET_DOWNLOADED"]
    assert download["ref_id"] == version_id


def test_events_without_an_evidence_type_add_nothing(db: PgUrls) -> None:
    emit(db, EventType.WORKSPACE_INPUT_REMOVED_V1, input_payload())
    relay(db)
    assert evidence(db) == []


def test_system_actor_downloads_are_ignored(db: PgUrls) -> None:
    emit(
        db,
        EventType.GOVERNANCE_DOWNLOAD_AUTHORIZED_V1,
        {
            "dataset_id": str(new_id()),
            "dataset_version_id": str(new_id()),
            "owner_organization_id": str(ORG_B),
            "project_id": str(PROJECT),
            "access_grant_id": None,
            "basis": "OWNER_ORGANIZATION",
            "file_ids": [],
            "ttl_seconds": 300,
            "policy_version": "1",
        },
        EventActor.system(),
    )
    relay(db)
    assert evidence(db) == []
