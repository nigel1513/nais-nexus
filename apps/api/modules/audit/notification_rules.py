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


# ---------------------------------------------------------------- contract 1.6.0: workspace (M13), notes (M14)


def _stewards(organization_ids: Iterable[Any]) -> list[UUID]:
    identity = audit_ports.identity()
    return [
        u
        for org in organization_ids
        for u in identity.list_users_with_org_role(UUID(str(org)), "DATA_STEWARD")
    ]


def _output_link(p: Payload) -> str:
    return f"/commons/projects/{p['project_id']}/outputs/{p['output_id']}"


def _publish_requested(p: Payload) -> list[NotificationDraft]:
    return _drafts(
        _stewards(p["approver_organization_ids"]),
        N.OUTPUT_PUBLISH_REQUESTED,
        f'"{p["output_title"]}" 허브 공개 검토 요청이 도착했습니다',
        f"프로젝트: {p['project_name']}",
        "/commons/access?tab=publish",
    )


def _publish_decided(p: Payload) -> list[NotificationDraft]:
    output, body = p["output_title"], ""
    if p.get("failure_reason"):  # system REJECT: the approved publication failed in the catalog (D-047)
        title, body = f'"{output}" 허브 공개에 실패했습니다', f"사유: {p['failure_reason']}"
    elif p["decision"] == "REJECT":
        title = f'"{output}" 허브 공개 요청이 반려되었습니다'
    elif p["request_status"] == "APPROVED":
        title = f'"{output}" 허브 공개가 승인되었습니다'
    else:
        title = f'"{output}" 허브 공개 요청이 일부 승인되었습니다 (다른 기관 검토 중)'
    return _drafts([UUID(p["requested_by"])], N.OUTPUT_PUBLISH_DECIDED, title, body, _output_link(p))


# workspace.run.failed.v1 carries a stable code (workspace public RUN_ERROR_CODES); the body is its Korean sentence.
RUN_ERROR_SENTENCES: dict[str, str] = {
    "RECIPE_MISSING": "실행할 레시피 버전을 찾을 수 없습니다.",
    "INPUT_ACCESS_LAPSED": "입력 데이터의 접근 권한이 회수되었거나 만료되었습니다.",
    "RECIPE_INVALID": "레시피 단계가 입력 데이터와 맞지 않습니다. 레시피를 확인해 주세요.",
    "RESULT_TOO_LARGE": "실행 결과의 행 수가 허용 한도를 넘었습니다. 필터나 행 제한 단계를 추가해 주세요.",
    "INPUT_UNAVAILABLE": "입력 데이터 버전을 더 이상 사용할 수 없습니다.",
    "INPUT_NOT_TABULAR": "입력 데이터에 읽을 수 있는 CSV·Parquet 파일이 없습니다.",
    "INPUT_TOO_LARGE": "입력 데이터가 허용 크기를 넘었습니다.",
    "INPUT_UNREADABLE": "입력 파일을 읽을 수 없습니다.",
    "STORAGE_NOT_CONFIGURED": "과제 주관기관의 저장소가 설정되지 않았습니다. 관리자에게 문의해 주세요.",
    "OUT_OF_MEMORY": "실행에 필요한 메모리가 부족합니다. 행 수를 줄여 다시 실행해 주세요.",
    "STORAGE_UNAVAILABLE": "저장소에 일시적으로 접근할 수 없습니다. 잠시 후 다시 실행해 주세요.",
    "INTERNAL_ERROR": "시스템 오류로 실행에 실패했습니다. 다시 실행해 주세요.",
    "RUN_TIMEOUT": "실행 시간이 허용 한도를 넘었습니다.",
    "STALE_RUN": "실행이 제때 진행되지 않아 중단되었습니다. 다시 실행해 주세요.",
}
RUN_ERROR_FALLBACK = "실행에 실패했습니다."


def run_error_sentence(error: object) -> str:
    # Older rows may still read `CODE: English text`; only the code is looked at.
    code = str(error or "").split(":", 1)[0].strip()
    return RUN_ERROR_SENTENCES.get(code, RUN_ERROR_FALLBACK)


def _run_failed(p: Payload) -> list[NotificationDraft]:
    # The run starter (payload actor_id) learns the outcome of their asynchronous run.
    return _drafts(
        [UUID(p["actor_id"])],
        N.RUN_FAILED,
        f'"{p["recipe_name"]}" 레시피 실행이 실패했습니다',
        run_error_sentence(p.get("error")),
        f"/commons/projects/{p['project_id']}/recipes/{p['recipe_id']}",
    )


def _comment_added(p: Payload) -> list[NotificationDraft]:
    # Only dataset discussions notify (the owner organization's stewards); project-side threads stay quiet.
    if p["scope"] != "DATASET" or p.get("owner_organization_id") is None:
        return []
    title = dataset_title(p["target_id"])
    what = "데이터에 새 토론이 시작되었습니다" if p["new_thread"] else "데이터 토론에 새 댓글이 달렸습니다"
    return _drafts(
        _stewards([p["owner_organization_id"]]),
        N.DATASET_COMMENT_ADDED,
        f'"{title}" {what}',
        f"토론: {p['thread_title']}",
        f"/commons/data/{p['target_id']}?tab=discussion",
    )


def _note(p: Payload) -> str:
    return f'"{p["project_name"]}" {p["note_date"]} 연구노트'


def _note_submitted(p: Payload) -> list[NotificationDraft]:
    return _drafts(
        [UUID(w) for w in p["witness_user_ids"]],
        N.NOTE_SUBMITTED,
        f"{_note(p)} 확인 요청이 도착했습니다",
        "",
        f"/commons/notes/{p['note_id']}",
    )


def _note_rejected(p: Payload) -> list[NotificationDraft]:
    return _drafts(
        [UUID(p["recorder_id"])],
        N.NOTE_REJECTED,
        f"{_note(p)}가 반려되었습니다",
        f"사유: {p['reason']}",
        f"/commons/notes/{p['note_id']}",
    )


def _note_signed(p: Payload) -> list[NotificationDraft]:
    note = _note(p)
    title = f"{note} 서명이 완료되었습니다" if p["final"] else f"{note}에 확인자 서명이 추가되었습니다"
    return _drafts([UUID(p["recorder_id"])], N.NOTE_SIGNED, title, "", f"/commons/notes/{p['note_id']}")


_BUILDERS: dict[str, Callable[[Payload], list[NotificationDraft]]] = {
    "project.member.added.v1": _member_added,
    "governance.access.requested.v1": _requested,
    "governance.access.approved.v1": _approved,
    "governance.access.rejected.v1": _rejected,
    "governance.access.changes_requested.v1": _changes_requested,
    "governance.access.expiring_soon.v1": _expiring,
    "governance.access.revoked.v1": _revoked,
    "catalog.dataset.version_published.v1": _published,
    "workspace.publish.requested.v1": _publish_requested,
    "workspace.publish.decided.v1": _publish_decided,
    "workspace.run.failed.v1": _run_failed,
    "workspace.comment.added.v1": _comment_added,
    "notes.note.submitted.v1": _note_submitted,
    "notes.note.rejected.v1": _note_rejected,
    "notes.note.signed.v1": _note_signed,
}

# Events whose recipients never include the acting user (a user is not told about their own action). A failed run
# is excluded on purpose: its envelope actor is the starter, who is exactly the person to tell.
_SKIP_ACTOR: frozenset[str] = frozenset(
    {
        "workspace.publish.requested.v1",
        "workspace.publish.decided.v1",
        "workspace.comment.added.v1",
        "notes.note.submitted.v1",
        "notes.note.rejected.v1",
        "notes.note.signed.v1",
    }
)


def build_drafts(event: EventEnvelope) -> list[NotificationDraft]:
    builder = _BUILDERS.get(event.event_type)
    if builder is None:
        return []
    drafts = builder(event.payload)
    if event.event_type in _SKIP_ACTOR and event.actor.user_id is not None:
        drafts = [d for d in drafts if d.recipient_user_id != event.actor.user_id]
    return drafts
