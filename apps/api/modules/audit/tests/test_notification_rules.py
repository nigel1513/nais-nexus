from typing import Any

import pytest

from api.modules.audit import ports as audit_ports
from api.modules.audit.fakes import (
    A_RESEARCHER,
    A_STEWARD,
    B_RESEARCHER,
    B_STEWARD,
    DATASET_BATTERY,
    ORG_A,
    ORG_B,
    FakeCatalog,
    FakeGrants,
    seed_id,
)
from api.modules.audit.notification_rules import DATASET_FALLBACK_TITLE, build_drafts
from api.modules.audit.tests.support.events import (
    ACTOR_A,
    ACTOR_B_STEWARD,
    GRANT_ID,
    NOTE_ID,
    OUTPUT_ID,
    PROJECT_GOLDEN,
    RECIPE_ID,
    REQUEST_ID,
    SYSTEM,
    as_json,
    envelope,
)
from api.platform import ports
from api.platform.events import EventActor
from api.platform.testing.contracts import assert_valid_event

ACTOR_A_STEWARD = EventActor(type="USER", user_id=A_STEWARD, organization_id=ORG_A)
ACTOR_B_RESEARCHER = EventActor(type="USER", user_id=B_RESEARCHER, organization_id=ORG_B)

T = "Battery Cycling Measurements"
ACCESS_LINK = f"/commons/access/{REQUEST_ID}"
GRANTS_LINK = "/commons/access?tab=grants"

CASES = [
    (
        "project.member.added.v1",
        B_RESEARCHER,
        "PROJECT_INVITATION",
        '"Golden Project" 프로젝트에 참여자로 추가되었습니다',
        f"/commons/projects/{PROJECT_GOLDEN}",
    ),
    (
        "governance.access.requested.v1",
        B_STEWARD,
        "ACCESS_SUBMITTED",
        f'"{T}" 데이터 접근 요청이 도착했습니다',
        ACCESS_LINK,
    ),
    (
        "governance.access.approved.v1",
        A_RESEARCHER,
        "ACCESS_APPROVED",
        f'"{T}" 접근이 승인되었습니다 (만료 2026-10-31)',
        ACCESS_LINK,
    ),
    (
        "governance.access.rejected.v1",
        A_RESEARCHER,
        "ACCESS_REJECTED",
        f'"{T}" 접근 요청이 거절되었습니다',
        ACCESS_LINK,
    ),
    (
        "governance.access.changes_requested.v1",
        A_RESEARCHER,
        "ACCESS_CHANGES_REQUESTED",
        f'"{T}" 접근 요청에 수정이 요청되었습니다',
        ACCESS_LINK,
    ),
    (
        "governance.access.expiring_soon.v1",
        A_RESEARCHER,
        "ACCESS_EXPIRING",
        f'"{T}" 접근 권한이 2026-10-04 09:30 UTC에 만료됩니다',
        GRANTS_LINK,
    ),
    (
        "governance.access.revoked.v1",
        A_RESEARCHER,
        "ACCESS_REVOKED",
        f'"{T}" 접근 권한이 회수되었습니다',
        GRANTS_LINK,
    ),
    (
        "catalog.dataset.version_published.v1",
        A_RESEARCHER,
        "DATASET_PUBLISHED",
        f'"{T}" 새 버전 v1이(가) 게시되었습니다',
        f"/commons/data/{DATASET_BATTERY}",
    ),
]


@pytest.mark.parametrize(("event_type", "recipient", "ntype", "title", "link"), CASES)
def test_rules_match_spec(event_type: str, recipient: object, ntype: str, title: str, link: str) -> None:
    [draft] = build_drafts(envelope(event_type))
    assert (draft.recipient_user_id, draft.type.value, draft.title, draft.link) == (
        recipient,
        ntype,
        title,
        link,
    )


def test_resubmission_title() -> None:
    [draft] = build_drafts(envelope("governance.access.requested.v1", resubmission=True))
    assert draft.title == f'"{T}" 데이터 접근 요청이 다시 제출되었습니다'


def test_self_add_creates_no_invitation() -> None:
    assert build_drafts(envelope("project.member.added.v1", added_by=B_RESEARCHER)) == []


def test_requester_is_never_notified_of_own_submission() -> None:  # M09-AT-10
    event = envelope("governance.access.requested.v1", requester_user_id=B_STEWARD)
    assert [d.recipient_user_id for d in build_drafts(event)] == []


def test_reason_and_comment_in_body() -> None:
    [rejected] = build_drafts(envelope("governance.access.rejected.v1"))
    assert "목적이 불명확합니다" in rejected.body
    [changes] = build_drafts(envelope("governance.access.changes_requested.v1"))
    assert "연구 목적을 구체화해 주세요" in changes.body


@pytest.mark.parametrize(
    "event_type",
    [
        "identity.user.logged_in.v1",
        "governance.access.withdrawn.v1",
        "governance.access.expired.v1",
        "governance.download.denied.v1",
        "readiness.validation.completed.v1",
    ],
)
def test_events_without_rules_produce_nothing(event_type: str) -> None:
    assert build_drafts(envelope(event_type)) == []


def test_missing_dataset_uses_fallback_title() -> None:
    ports.provide(audit_ports.CatalogQueryPort, FakeCatalog([]))
    [draft] = build_drafts(envelope("governance.access.revoked.v1"))
    assert draft.title.startswith(f'"{DATASET_FALLBACK_TITLE}"')


class BrokenCatalog:
    def get_policy_view(self, dataset_id: Any) -> Any:
        raise TimeoutError("catalog down")


def test_catalog_failure_uses_fallback_title() -> None:
    ports.provide(audit_ports.CatalogQueryPort, BrokenCatalog())
    [draft] = build_drafts(envelope("governance.access.approved.v1"))
    assert draft.title.startswith('"데이터셋"')


def test_grant_id_not_in_link() -> None:
    [draft] = build_drafts(envelope("governance.access.revoked.v1"))
    assert str(GRANT_ID) not in draft.link


def test_published_recipients_are_deduplicated_and_ordered() -> None:
    low, high = seed_id("0a01"), seed_id("0b01")
    ports.provide(audit_ports.GrantQueryPort, FakeGrants({DATASET_BATTERY: [high, low, high, low]}))
    drafts = build_drafts(envelope("catalog.dataset.version_published.v1"))
    assert [d.recipient_user_id for d in drafts] == [low, high]


# ---------------------------------------------------------------- contract 1.6.0: workspace and research notes

OUT = "High temperature mean"
OUTPUT_LINK = f"/commons/projects/{PROJECT_GOLDEN}/outputs/{OUTPUT_ID}"
NOTE_LINK = f"/commons/notes/{NOTE_ID}"
NOTE = '"Golden Project" 2026-10-02 연구노트'

NEW_CASES = [
    (
        "workspace.publish.requested.v1",
        ACTOR_A,
        {},
        B_STEWARD,
        "OUTPUT_PUBLISH_REQUESTED",
        f'"{OUT}" 허브 공개 검토 요청이 도착했습니다',
        "/commons/access?tab=publish",
    ),
    (
        "workspace.publish.decided.v1",
        ACTOR_B_STEWARD,
        {},
        A_RESEARCHER,
        "OUTPUT_PUBLISH_DECIDED",
        f'"{OUT}" 허브 공개가 승인되었습니다',
        OUTPUT_LINK,
    ),
    (
        "workspace.publish.decided.v1",
        ACTOR_B_STEWARD,
        {"request_status": "PENDING"},
        A_RESEARCHER,
        "OUTPUT_PUBLISH_DECIDED",
        f'"{OUT}" 허브 공개 요청이 일부 승인되었습니다 (다른 기관 검토 중)',
        OUTPUT_LINK,
    ),
    (
        "workspace.publish.decided.v1",
        ACTOR_B_STEWARD,
        {"decision": "REJECT", "request_status": "REJECTED"},
        A_RESEARCHER,
        "OUTPUT_PUBLISH_DECIDED",
        f'"{OUT}" 허브 공개 요청이 반려되었습니다',
        OUTPUT_LINK,
    ),
    (
        "workspace.publish.decided.v1",
        SYSTEM,
        {
            "decision": "REJECT",
            "request_status": "REJECTED",
            "failure_reason": "카탈로그가 공개를 거부했습니다",
        },
        A_RESEARCHER,
        "OUTPUT_PUBLISH_DECIDED",
        f'"{OUT}" 허브 공개에 실패했습니다',
        OUTPUT_LINK,
    ),
    (
        "workspace.run.failed.v1",
        ACTOR_A,
        {},
        A_RESEARCHER,
        "RUN_FAILED",
        f'"{OUT}" 레시피 실행이 실패했습니다',
        f"/commons/projects/{PROJECT_GOLDEN}/recipes/{RECIPE_ID}",
    ),
    (
        "workspace.comment.added.v1",
        ACTOR_A,
        {},
        B_STEWARD,
        "DATASET_COMMENT_ADDED",
        f'"{T}" 데이터에 새 토론이 시작되었습니다',
        f"/commons/data/{DATASET_BATTERY}?tab=discussion",
    ),
    (
        "workspace.comment.added.v1",
        ACTOR_A,
        {"new_thread": False},
        B_STEWARD,
        "DATASET_COMMENT_ADDED",
        f'"{T}" 데이터 토론에 새 댓글이 달렸습니다',
        f"/commons/data/{DATASET_BATTERY}?tab=discussion",
    ),
    (
        "notes.note.submitted.v1",
        ACTOR_A,
        {},
        B_RESEARCHER,
        "NOTE_SUBMITTED",
        f"{NOTE} 확인 요청이 도착했습니다",
        NOTE_LINK,
    ),
    (
        "notes.note.rejected.v1",
        ACTOR_B_RESEARCHER,
        {},
        A_RESEARCHER,
        "NOTE_REJECTED",
        f"{NOTE}가 반려되었습니다",
        NOTE_LINK,
    ),
    (
        "notes.note.signed.v1",
        ACTOR_B_RESEARCHER,
        {"signer_id": B_RESEARCHER, "signer_role": "WITNESS"},
        A_RESEARCHER,
        "NOTE_SIGNED",
        f"{NOTE} 서명이 완료되었습니다",
        NOTE_LINK,
    ),
    (
        "notes.note.signed.v1",
        ACTOR_B_RESEARCHER,
        {"signer_id": B_RESEARCHER, "signer_role": "WITNESS", "final": False, "chain_hash": None},
        A_RESEARCHER,
        "NOTE_SIGNED",
        f"{NOTE}에 확인자 서명이 추가되었습니다",
        NOTE_LINK,
    ),
]


@pytest.mark.parametrize(
    ("event_type", "actor", "overrides", "recipient", "ntype", "title", "link"), NEW_CASES
)
def test_workspace_and_notes_rules(
    event_type: str,
    actor: EventActor,
    overrides: dict[str, Any],
    recipient: object,
    ntype: str,
    title: str,
    link: str,
) -> None:
    event = envelope(event_type, actor=actor, **overrides)
    assert_valid_event(as_json(event))
    [draft] = build_drafts(event)
    assert (draft.recipient_user_id, draft.type.value, draft.title, draft.link) == (
        recipient,
        ntype,
        title,
        link,
    )


def test_publish_request_notifies_every_slot_organizations_stewards_but_not_the_actor() -> None:
    event = envelope(
        "workspace.publish.requested.v1",
        actor=ACTOR_A_STEWARD,
        approver_organization_ids=[str(ORG_A), str(ORG_B)],
    )
    drafts = build_drafts(event)
    assert [d.recipient_user_id for d in drafts] == [B_STEWARD]
    assert drafts[0].body == "프로젝트: Golden Project"
    both = build_drafts(
        envelope("workspace.publish.requested.v1", approver_organization_ids=[str(ORG_A), str(ORG_B)])
    )
    assert sorted(d.recipient_user_id for d in both) == sorted([A_STEWARD, B_STEWARD])


def test_publication_failure_reason_in_body() -> None:
    [draft] = build_drafts(
        envelope(
            "workspace.publish.decided.v1",
            actor=SYSTEM,
            decision="REJECT",
            request_status="REJECTED",
            failure_reason="카탈로그가 공개를 거부했습니다",
        )
    )
    assert draft.body == "사유: 카탈로그가 공개를 거부했습니다"


def test_run_failure_error_summary_in_body() -> None:
    [draft] = build_drafts(envelope("workspace.run.failed.v1"))
    assert draft.body == "오류: column not found"


def test_note_rejection_reason_in_body() -> None:
    [draft] = build_drafts(envelope("notes.note.rejected.v1", actor=ACTOR_B_RESEARCHER))
    assert draft.body == "사유: 근거 보완 필요"


@pytest.mark.parametrize(
    ("event_type", "actor", "overrides"),
    [
        ("workspace.publish.decided.v1", ACTOR_A, {}),  # the requester never decides, but never self-notify
        ("notes.note.signed.v1", ACTOR_A, {}),  # the recorder signing their own note
        ("notes.note.rejected.v1", ACTOR_A, {}),
        ("notes.note.submitted.v1", ACTOR_B_RESEARCHER, {}),  # a witness who is the actor
        ("workspace.comment.added.v1", ACTOR_B_STEWARD, {}),  # the owner's steward commenting
    ],
)
def test_the_actor_is_never_notified_of_their_own_action(
    event_type: str, actor: EventActor, overrides: dict[str, Any]
) -> None:
    assert build_drafts(envelope(event_type, actor=actor, **overrides)) == []


@pytest.mark.parametrize("scope", ["PROJECT", "OUTPUT", "RECIPE"])
def test_project_scope_comments_notify_nobody(scope: str) -> None:
    event = envelope(
        "workspace.comment.added.v1",
        scope=scope,
        project_id=PROJECT_GOLDEN,
        target_id=PROJECT_GOLDEN,
        owner_organization_id=None,
    )
    assert build_drafts(event) == []


@pytest.mark.parametrize(
    "event_type",
    [
        "workspace.input.added.v1",
        "workspace.input.version_changed.v1",
        "workspace.input.removed.v1",
        "workspace.recipe.saved.v1",
        "workspace.run.succeeded.v1",
        "workspace.output.created.v1",
        "notes.note.viewed.v1",
    ],
)
def test_audit_only_events_produce_no_notification(event_type: str) -> None:
    assert build_drafts(envelope(event_type, actor=ACTOR_B_STEWARD)) == []


def test_notes_submitted_to_several_witnesses() -> None:
    event = envelope(
        "notes.note.submitted.v1", witness_user_ids=[str(B_STEWARD), str(B_RESEARCHER), str(B_STEWARD)]
    )
    assert sorted(d.recipient_user_id for d in build_drafts(event)) == sorted([B_RESEARCHER, B_STEWARD])
