"""Contract-valid envelopes for every P0 event type (validated in test_mapping.py)."""

from copy import deepcopy
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from api.modules.audit.fakes import (
    A_RESEARCHER,
    B_RESEARCHER,
    B_STEWARD,
    DATASET_BATTERY,
    ORG_A,
    ORG_B,
    SEED_PROJECT,
    seed_id,
)
from api.platform.events import EventActor, EventEnvelope
from api.platform.generated.event_types import PRODUCER, EventType
from api.platform.ids import new_id

PROJECT_GOLDEN = SEED_PROJECT
OTHER_PROJECT = seed_id("9999")
REQUEST_ID, GRANT_ID = seed_id("3001"), seed_id("4001")
VERSION_ID, VALIDATION_ID, FILE_ID = seed_id("5001"), seed_id("6001"), seed_id("7001")

ACTOR_A = EventActor(type="USER", user_id=A_RESEARCHER, organization_id=ORG_A)
ACTOR_B_STEWARD = EventActor(type="USER", user_id=B_STEWARD, organization_id=ORG_B)
SYSTEM = EventActor.system()

S = str
DATASET_TITLE = "Battery Cycling Measurements"
POLICY_VERSION = "policy-2026.10.01"
_request = {
    "access_request_id": S(REQUEST_ID),
    "dataset_id": S(DATASET_BATTERY),
    "project_id": S(PROJECT_GOLDEN),
    "requester_user_id": S(A_RESEARCHER),
    "owner_organization_id": S(ORG_B),
}
_grant = {
    "access_grant_id": S(GRANT_ID),
    "dataset_id": S(DATASET_BATTERY),
    "project_id": S(PROJECT_GOLDEN),
    "subject_user_id": S(A_RESEARCHER),
    "owner_organization_id": S(ORG_B),
}
_policy_prev = {"allowed_purposes": ["ACADEMIC_RESEARCH"], "approval_required": True, "max_grant_days": 180}
_policy_cur = {
    "allowed_purposes": ["ACADEMIC_RESEARCH", "AI_TRAINING"],
    "approval_required": True,
    "max_grant_days": 180,
}

PAYLOADS: dict[str, dict[str, Any]] = {
    "identity.organization.created.v1": {
        "organization_id": S(ORG_B),
        "code": "inst-b",
        "name": "Institute B",
        "type": "RESEARCH_INSTITUTE",
    },
    "identity.user.created.v1": {
        "user_id": S(B_RESEARCHER),
        "organization_id": S(ORG_B),
        "display_name": "B Researcher",
        "email": "b.researcher@inst-b.local",
    },
    "identity.user.logged_in.v1": {
        "user_id": S(A_RESEARCHER),
        "organization_id": S(ORG_A),
        "session_id": "session-1",
    },
    "identity.membership.changed.v1": {
        "user_id": S(B_STEWARD),
        "organization_id": S(ORG_B),
        "previous_roles": [],
        "roles": ["DATA_STEWARD"],
        "previous_status": "ACTIVE",
        "status": "ACTIVE",
    },
    "project.created.v1": {
        "project_id": S(PROJECT_GOLDEN),
        "name": "Golden Project",
        "lead_organization_id": S(ORG_A),
        "visibility": "PRIVATE",
        "owner_user_id": S(A_RESEARCHER),
    },
    "project.archived.v1": {"project_id": S(PROJECT_GOLDEN)},
    "project.member.added.v1": {
        "project_id": S(PROJECT_GOLDEN),
        "project_name": "Golden Project",
        "user_id": S(B_RESEARCHER),
        "organization_id": S(ORG_B),
        "role": "RESEARCHER",
        "added_by": S(A_RESEARCHER),
    },
    "project.member.removed.v1": {
        "project_id": S(PROJECT_GOLDEN),
        "user_id": S(B_RESEARCHER),
        "organization_id": S(ORG_B),
        "removed_by": S(A_RESEARCHER),
        "reason": None,
    },
    "project.member.role_changed.v1": {
        "project_id": S(PROJECT_GOLDEN),
        "user_id": S(B_RESEARCHER),
        "previous_role": "RESEARCHER",
        "role": "VIEWER",
        "changed_by": S(A_RESEARCHER),
    },
    "catalog.dataset.created.v1": {
        "dataset_id": S(DATASET_BATTERY),
        "owner_organization_id": S(ORG_B),
        "title": DATASET_TITLE,
        "access_level": "CONTROLLED",
    },
    "catalog.dataset.access_level_changed.v1": {
        "dataset_id": S(DATASET_BATTERY),
        "owner_organization_id": S(ORG_B),
        "previous_access_level": "CONTROLLED",
        "access_level": "SENSITIVE",
    },
    "catalog.dataset.policy_changed.v1": {
        "dataset_id": S(DATASET_BATTERY),
        "owner_organization_id": S(ORG_B),
        "previous": _policy_prev,
        "current": _policy_cur,
    },
    "catalog.dataset.metadata_changed.v1": {
        "dataset_id": S(DATASET_BATTERY),
        "owner_organization_id": S(ORG_B),
        "changed_fields": ["title"],
    },
    "identity.user.updated.v1": {
        "user_id": S(A_RESEARCHER),
        "organization_id": S(ORG_A),
        "changed_fields": ["national_researcher_number"],
    },
    "catalog.dataset.version_published.v1": {
        "dataset_id": S(DATASET_BATTERY),
        "dataset_version_id": S(VERSION_ID),
        "version_label": "v1",
        "owner_organization_id": S(ORG_B),
        "file_count": 1,
        "total_bytes": 1024,
        "manifest_sha256": "0" * 64,
    },
    "governance.access.requested.v1": {
        **_request,
        "requester_organization_id": S(ORG_A),
        "purpose": "ACADEMIC_RESEARCH",
        "operations": ["READ"],
        "requested_days": 30,
        "resubmission": False,
        "dataset_title": DATASET_TITLE,
        "project_name": "Golden Project",
    },
    "governance.access.review_started.v1": {**_request, "reviewer_user_id": S(B_STEWARD)},
    "governance.access.approved.v1": {
        "access_request_id": S(REQUEST_ID),
        **_grant,
        "operations": ["READ"],
        "valid_from": "2026-10-01T00:00:00Z",
        "expires_at": "2026-10-31T00:00:00Z",
        "policy_version": POLICY_VERSION,
        "reviewer_user_id": S(B_STEWARD),
    },
    "governance.access.rejected.v1": {
        **_request,
        "reviewer_user_id": S(B_STEWARD),
        "reason": "목적이 불명확합니다",
    },
    "governance.access.changes_requested.v1": {
        **_request,
        "reviewer_user_id": S(B_STEWARD),
        "comment": "연구 목적을 구체화해 주세요",
    },
    "governance.access.withdrawn.v1": dict(_request),
    "governance.access.revoked.v1": {
        **_grant,
        "revoked_by": S(B_STEWARD),
        "reason": "프로젝트 종료",
        "revocation_cause": "MANUAL",
    },
    "governance.access.expiring_soon.v1": {**_grant, "expires_at": "2026-10-04T09:30:00Z"},
    "governance.access.expired.v1": {**_grant, "expires_at": "2026-10-31T00:00:00Z"},
    "governance.download.authorized.v1": {
        "dataset_id": S(DATASET_BATTERY),
        "dataset_version_id": S(VERSION_ID),
        "owner_organization_id": S(ORG_B),
        "project_id": S(PROJECT_GOLDEN),
        "access_grant_id": S(GRANT_ID),
        "basis": "GRANT",
        "file_ids": [S(FILE_ID)],
        "ttl_seconds": 300,
        "policy_version": POLICY_VERSION,
    },
    "governance.download.denied.v1": {
        "dataset_id": S(DATASET_BATTERY),
        "dataset_version_id": S(VERSION_ID),
        "owner_organization_id": S(ORG_B),
        "project_id": S(PROJECT_GOLDEN),
        "error_code": "ACCESS_GRANT_EXPIRED",
        "reasons": ["grant expired"],
    },
    "readiness.validation.started.v1": {
        "validation_id": S(VALIDATION_ID),
        "dataset_id": S(DATASET_BATTERY),
        "dataset_version_id": S(VERSION_ID),
        "profile_id": "default",
        "profile_version": "1.0.0",
    },
    "readiness.validation.completed.v1": {
        "validation_id": S(VALIDATION_ID),
        "dataset_id": S(DATASET_BATTERY),
        "dataset_version_id": S(VERSION_ID),
        "owner_organization_id": S(ORG_B),
        "profile_id": "default",
        "profile_version": "1.0.0",
        "run_status": "COMPLETED",
        "overall_status": "PASS",
        "summary": {"pass": 10, "warning": 0, "fail": 0, "not_applicable": 2},
        "validator_version": "1.0.0",
        "input_fingerprint": "f" * 64,
    },
}


def payload_for(event_type: str) -> dict[str, Any]:
    return deepcopy(PAYLOADS[event_type])


def _jsonable(value: Any) -> Any:
    return str(value) if isinstance(value, UUID) else value


def envelope(
    event_type: str,
    *,
    actor: EventActor = ACTOR_A,
    correlation_id: UUID | None = None,
    occurred_at: datetime | None = None,
    **payload_overrides: Any,
) -> EventEnvelope:
    payload = payload_for(event_type)
    payload.update({k: _jsonable(v) for k, v in payload_overrides.items()})
    kind = EventType(event_type)
    return EventEnvelope(
        event_id=new_id(),
        event_type=kind.value,
        occurred_at=occurred_at or datetime.now(UTC),
        producer=PRODUCER[kind],
        correlation_id=correlation_id or new_id(),
        actor=actor,
        payload=payload,
    )


def as_json(event: EventEnvelope) -> dict[str, Any]:
    return event.model_dump(mode="json")
