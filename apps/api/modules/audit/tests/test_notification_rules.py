from typing import Any

import pytest

from api.modules.audit import ports as audit_ports
from api.modules.audit.fakes import (
    A_RESEARCHER,
    B_RESEARCHER,
    B_STEWARD,
    DATASET_BATTERY,
    FakeCatalog,
    FakeGrants,
    seed_id,
)
from api.modules.audit.notification_rules import DATASET_FALLBACK_TITLE, build_drafts
from api.modules.audit.tests.support.events import GRANT_ID, PROJECT_GOLDEN, REQUEST_ID, envelope
from api.platform import ports

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
