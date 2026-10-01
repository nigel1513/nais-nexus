"""Event -> audit record rules (spec §7.1). Pure: no DB, no ports."""

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from nais_contracts.api_models import AuditAction as A
from nais_contracts.api_models import ResourceType as R

from api.platform.events import EventEnvelope

EXCLUDED_DETAIL_KEYS = frozenset({"purpose_detail"})


@dataclass(frozen=True)
class AuditRule:
    action: A
    resource_type: R
    resource_key: str
    owner_key: str | None = None
    project_key: str | None = None
    reason_key: str | None = None
    copy_policy_version: bool = False
    result: str = "SUCCESS"


@dataclass(frozen=True)
class AuditRecord:
    occurred_at: datetime
    action: str
    result: str
    reason: str | None
    actor_type: str
    actor_user_id: UUID | None
    actor_organization_id: UUID | None
    resource_type: str
    resource_id: UUID
    resource_owner_organization_id: UUID | None
    project_id: UUID | None
    policy_version: str | None
    source_event_id: UUID
    source_event_type: str
    trace_id: str
    details: dict[str, Any]


_OWNER = "owner_organization_id"
_PROJ = "project_id"

AUDIT_RULES: dict[str, AuditRule] = {
    "identity.organization.created.v1": AuditRule(
        A.ORGANIZATION_CREATED, R.ORGANIZATION, "organization_id", owner_key="organization_id"
    ),
    "identity.user.created.v1": AuditRule(A.USER_CREATED, R.USER, "user_id", owner_key="organization_id"),
    "identity.user.logged_in.v1": AuditRule(A.LOGIN, R.USER, "user_id", owner_key="organization_id"),
    "identity.membership.changed.v1": AuditRule(
        A.ADMIN_ROLE_CHANGED, R.MEMBERSHIP, "user_id", owner_key="organization_id"
    ),
    "project.created.v1": AuditRule(
        A.PROJECT_CREATED, R.PROJECT, "project_id", owner_key="lead_organization_id", project_key="project_id"
    ),
    "project.archived.v1": AuditRule(A.PROJECT_ARCHIVED, R.PROJECT, "project_id", project_key="project_id"),
    "project.member.added.v1": AuditRule(
        A.PROJECT_MEMBER_ADDED,
        R.PROJECT_MEMBER,
        "user_id",
        owner_key="organization_id",
        project_key="project_id",
    ),
    "project.member.removed.v1": AuditRule(
        A.PROJECT_MEMBER_REMOVED,
        R.PROJECT_MEMBER,
        "user_id",
        owner_key="organization_id",
        project_key="project_id",
    ),
    "project.member.role_changed.v1": AuditRule(
        A.PROJECT_MEMBER_ROLE_CHANGED, R.PROJECT_MEMBER, "user_id", project_key="project_id"
    ),
    "catalog.dataset.created.v1": AuditRule(
        A.DATASET_CREATED, R.DATASET, "dataset_id", owner_key="owner_organization_id"
    ),
    "catalog.dataset.access_level_changed.v1": AuditRule(
        A.POLICY_CHANGED, R.DATASET, "dataset_id", owner_key="owner_organization_id"
    ),
    "catalog.dataset.policy_changed.v1": AuditRule(
        A.POLICY_CHANGED, R.DATASET, "dataset_id", owner_key="owner_organization_id"
    ),
    "catalog.dataset.version_published.v1": AuditRule(
        A.DATASET_VERSION_PUBLISHED,
        R.DATASET_VERSION,
        "dataset_version_id",
        owner_key="owner_organization_id",
    ),
    "governance.access.requested.v1": AuditRule(
        A.ACCESS_REQUESTED, R.ACCESS_REQUEST, "access_request_id", owner_key=_OWNER, project_key=_PROJ
    ),
    "governance.access.review_started.v1": AuditRule(
        A.ACCESS_REVIEW_STARTED, R.ACCESS_REQUEST, "access_request_id", owner_key=_OWNER, project_key=_PROJ
    ),
    "governance.access.approved.v1": AuditRule(
        A.ACCESS_APPROVED,
        R.ACCESS_GRANT,
        "access_grant_id",
        copy_policy_version=True,
        owner_key=_OWNER,
        project_key=_PROJ,
    ),
    "governance.access.rejected.v1": AuditRule(
        A.ACCESS_REJECTED,
        R.ACCESS_REQUEST,
        "access_request_id",
        reason_key="reason",
        owner_key=_OWNER,
        project_key=_PROJ,
    ),
    "governance.access.changes_requested.v1": AuditRule(
        A.ACCESS_CHANGES_REQUESTED,
        R.ACCESS_REQUEST,
        "access_request_id",
        reason_key="comment",
        owner_key=_OWNER,
        project_key=_PROJ,
    ),
    "governance.access.withdrawn.v1": AuditRule(
        A.ACCESS_WITHDRAWN, R.ACCESS_REQUEST, "access_request_id", owner_key=_OWNER, project_key=_PROJ
    ),
    "governance.access.revoked.v1": AuditRule(
        A.ACCESS_REVOKED,
        R.ACCESS_GRANT,
        "access_grant_id",
        reason_key="reason",
        owner_key=_OWNER,
        project_key=_PROJ,
    ),
    "governance.access.expired.v1": AuditRule(
        A.ACCESS_EXPIRED, R.ACCESS_GRANT, "access_grant_id", owner_key=_OWNER, project_key=_PROJ
    ),
    "governance.download.authorized.v1": AuditRule(
        A.FILE_DOWNLOADED,
        R.DATASET_VERSION,
        "dataset_version_id",
        copy_policy_version=True,
        owner_key=_OWNER,
        project_key=_PROJ,
    ),
    "governance.download.denied.v1": AuditRule(
        A.DOWNLOAD_DENIED,
        R.DATASET_VERSION,
        "dataset_version_id",
        reason_key="error_code",
        result="DENIED",
        owner_key=_OWNER,
        project_key=_PROJ,
    ),
    "readiness.validation.completed.v1": AuditRule(
        A.READINESS_VALIDATION_COMPLETED,
        R.READINESS_VALIDATION,
        "validation_id",
        owner_key="owner_organization_id",
    ),
}

# Consumed but intentionally not audited: still claimed as audit_writer so they are not reprocessed.
NOT_AUDITED: frozenset[str] = frozenset(
    {"governance.access.expiring_soon.v1", "readiness.validation.started.v1"}
)

# 04_SECURITY_GOVERNANCE §6 required audit actions.
REQUIRED_ACTIONS: frozenset[str] = frozenset(
    {
        "LOGIN",
        "PROJECT_MEMBER_ADDED",
        "DATASET_CREATED",
        "DATASET_VERSION_PUBLISHED",
        "ACCESS_REQUESTED",
        "ACCESS_APPROVED",
        "ACCESS_REJECTED",
        "ACCESS_REVOKED",
        "ACCESS_EXPIRED",
        "FILE_DOWNLOADED",
        "POLICY_CHANGED",
        "ADMIN_ROLE_CHANGED",
    }
)


def sanitize_details(value: Any) -> Any:
    """Copy of the payload without free-text purpose_detail at any depth."""
    if isinstance(value, dict):
        return {k: sanitize_details(v) for k, v in value.items() if k not in EXCLUDED_DETAIL_KEYS}
    if isinstance(value, list):
        return [sanitize_details(v) for v in value]
    return value


def _uuid(value: Any) -> UUID | None:
    return None if value is None else UUID(str(value))


def to_audit_record(event: EventEnvelope) -> AuditRecord | None:
    rule = AUDIT_RULES.get(event.event_type)
    if rule is None:
        return None
    payload = event.payload
    resource_id = _uuid(payload.get(rule.resource_key))
    if resource_id is None:  # explicit (assert is stripped under -O); the schema requires every resource key
        raise ValueError(f"{event.event_type}: payload.{rule.resource_key} is required")
    reason_value = payload.get(rule.reason_key) if rule.reason_key else None
    return AuditRecord(
        occurred_at=event.occurred_at,
        action=rule.action.value,
        result=rule.result,
        reason=None if reason_value is None else str(reason_value),
        actor_type=event.actor.type,
        actor_user_id=event.actor.user_id,
        actor_organization_id=event.actor.organization_id,
        resource_type=rule.resource_type.value,
        resource_id=resource_id,
        resource_owner_organization_id=_uuid(payload.get(rule.owner_key)) if rule.owner_key else None,
        project_id=_uuid(payload.get(rule.project_key)) if rule.project_key else None,
        policy_version=str(payload["policy_version"]) if rule.copy_policy_version else None,
        source_event_id=event.event_id,
        source_event_type=event.event_type,
        trace_id=event.correlation_id.hex,
        details=sanitize_details(payload),
    )
