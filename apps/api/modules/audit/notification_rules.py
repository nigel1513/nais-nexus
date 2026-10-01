"""Event -> notification drafts (spec §7.3). Titles are Korean (single locale, P0). No data values in text."""

import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from nais_contracts.api_models import NotificationType as N

from api.modules.audit import ports as audit_ports
from api.platform.events import EventEnvelope

logger = logging.getLogger("nais.audit")
DATASET_FALLBACK_TITLE = "데이터셋"
Payload = dict[str, Any]


@dataclass(frozen=True)
class NotificationDraft:
    recipient_user_id: UUID
    type: N
    title: str
    body: str
    link: str


def dataset_title(dataset_id: Any) -> str:
    try:
        view = audit_ports.catalog().get_policy_view(UUID(str(dataset_id)))
    except Exception:
        logger.warning("catalog lookup failed; using fallback dataset title", exc_info=True)
        return DATASET_FALLBACK_TITLE
    return view.title if view is not None else DATASET_FALLBACK_TITLE


def _utc(value: str) -> datetime:
    return datetime.fromisoformat(value).astimezone(UTC)


def _drafts(
    recipients: Iterable[UUID], ntype: N, title: str, body: str, link: str
) -> list[NotificationDraft]:
    return [NotificationDraft(r, ntype, title, body, link) for r in sorted(set(recipients), key=str)]


def _member_added(p: Payload) -> list[NotificationDraft]:
    if p["added_by"] == p["user_id"]:
        return []
    return _drafts(
        [UUID(p["user_id"])],
        N.PROJECT_INVITATION,
        f'"{p["project_name"]}" 프로젝트에 참여자로 추가되었습니다',
        "",
        f"/commons/projects/{p['project_id']}",
    )


def _requested(p: Payload) -> list[NotificationDraft]:
    verb = "다시 제출되었습니다" if p["resubmission"] else "도착했습니다"
    requester = UUID(p["requester_user_id"])
    stewards = audit_ports.identity().list_users_with_org_role(
        UUID(p["owner_organization_id"]), "DATA_STEWARD"
    )
    return _drafts(
        [s for s in stewards if s != requester],
        N.ACCESS_SUBMITTED,
        f'"{p["dataset_title"]}" 데이터 접근 요청이 {verb}',
        f"프로젝트: {p['project_name']}",
        f"/commons/access/{p['access_request_id']}",
    )


def _approved(p: Payload) -> list[NotificationDraft]:
    title = (
        f'"{dataset_title(p["dataset_id"])}" 접근이 승인되었습니다 (만료 {_utc(p["expires_at"]):%Y-%m-%d})'
    )
    return _drafts(
        [UUID(p["subject_user_id"])],
        N.ACCESS_APPROVED,
        title,
        "",
        f"/commons/access/{p['access_request_id']}",
    )


def _rejected(p: Payload) -> list[NotificationDraft]:
    return _drafts(
        [UUID(p["requester_user_id"])],
        N.ACCESS_REJECTED,
        f'"{dataset_title(p["dataset_id"])}" 접근 요청이 거절되었습니다',
        f"사유: {p['reason']}",
        f"/commons/access/{p['access_request_id']}",
    )


def _changes_requested(p: Payload) -> list[NotificationDraft]:
    return _drafts(
        [UUID(p["requester_user_id"])],
        N.ACCESS_CHANGES_REQUESTED,
        f'"{dataset_title(p["dataset_id"])}" 접근 요청에 수정이 요청되었습니다',
        f"요청 사항: {p['comment']}",
        f"/commons/access/{p['access_request_id']}",
    )


def _expiring(p: Payload) -> list[NotificationDraft]:
    title = f'"{dataset_title(p["dataset_id"])}" 접근 권한이 {_utc(p["expires_at"]):%Y-%m-%d %H:%M} UTC에 만료됩니다'
    return _drafts([UUID(p["subject_user_id"])], N.ACCESS_EXPIRING, title, "", "/commons/access?tab=grants")


def _revoked(p: Payload) -> list[NotificationDraft]:
    return _drafts(
        [UUID(p["subject_user_id"])],
        N.ACCESS_REVOKED,
        f'"{dataset_title(p["dataset_id"])}" 접근 권한이 회수되었습니다',
        f"사유: {p['reason']}",
        "/commons/access?tab=grants",
    )


def _published(p: Payload) -> list[NotificationDraft]:
    subjects = audit_ports.grants().list_active_grant_subjects(UUID(p["dataset_id"]))
    return _drafts(
        subjects,
        N.DATASET_PUBLISHED,
        f'"{dataset_title(p["dataset_id"])}" 새 버전 {p["version_label"]}이(가) 게시되었습니다',
        "",
        f"/commons/data/{p['dataset_id']}",
    )


_BUILDERS: dict[str, Callable[[Payload], list[NotificationDraft]]] = {
    "project.member.added.v1": _member_added,
    "governance.access.requested.v1": _requested,
    "governance.access.approved.v1": _approved,
    "governance.access.rejected.v1": _rejected,
    "governance.access.changes_requested.v1": _changes_requested,
    "governance.access.expiring_soon.v1": _expiring,
    "governance.access.revoked.v1": _revoked,
    "catalog.dataset.version_published.v1": _published,
}


def build_drafts(event: EventEnvelope) -> list[NotificationDraft]:
    builder = _BUILDERS.get(event.event_type)
    return builder(event.payload) if builder is not None else []
