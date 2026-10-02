import json
from uuid import UUID

import pytest

from api.modules.audit.fakes import A_RESEARCHER, ORG_A, ORG_B
from api.modules.audit.mapping import (
    AUDIT_RULES,
    NOT_AUDITED,
    REQUIRED_ACTIONS,
    sanitize_details,
    to_audit_record,
)
from api.modules.audit.tests.support.events import (
    GRANT_ID,
    PAYLOADS,
    POLICY_VERSION,
    PROJECT_GOLDEN,
    REQUEST_ID,
    SYSTEM,
    VALIDATION_ID,
    VERSION_ID,
    as_json,
    envelope,
)
from api.platform.generated.event_types import EventType
from api.platform.settings import get_settings
from api.platform.testing.contracts import assert_valid_event

P = PROJECT_GOLDEN
# event_type -> (action, result, resource_type, resource_id, owner_org, project_id)
EXPECTED = {
    "identity.organization.created.v1": (
        "ORGANIZATION_CREATED",
        "SUCCESS",
        "ORGANIZATION",
        ORG_B,
        ORG_B,
        None,
    ),
    "identity.user.created.v1": (
        "USER_CREATED",
        "SUCCESS",
        "USER",
        UUID(PAYLOADS["identity.user.created.v1"]["user_id"]),
        ORG_B,
        None,
    ),
    "identity.user.logged_in.v1": ("LOGIN", "SUCCESS", "USER", A_RESEARCHER, ORG_A, None),
    "identity.membership.changed.v1": (
        "ADMIN_ROLE_CHANGED",
        "SUCCESS",
        "MEMBERSHIP",
        UUID(PAYLOADS["identity.membership.changed.v1"]["user_id"]),
        ORG_B,
        None,
    ),
    "project.created.v1": ("PROJECT_CREATED", "SUCCESS", "PROJECT", P, ORG_A, P),
    "project.archived.v1": ("PROJECT_ARCHIVED", "SUCCESS", "PROJECT", P, None, P),
    "project.member.added.v1": (
        "PROJECT_MEMBER_ADDED",
        "SUCCESS",
        "PROJECT_MEMBER",
        UUID(PAYLOADS["project.member.added.v1"]["user_id"]),
        ORG_B,
        P,
    ),
    "project.member.removed.v1": (
        "PROJECT_MEMBER_REMOVED",
        "SUCCESS",
        "PROJECT_MEMBER",
        UUID(PAYLOADS["project.member.removed.v1"]["user_id"]),
        ORG_B,
        P,
    ),
    "project.member.role_changed.v1": (
        "PROJECT_MEMBER_ROLE_CHANGED",
        "SUCCESS",
        "PROJECT_MEMBER",
        UUID(PAYLOADS["project.member.role_changed.v1"]["user_id"]),
        None,
        P,
    ),
    "catalog.dataset.created.v1": (
        "DATASET_CREATED",
        "SUCCESS",
        "DATASET",
        UUID(PAYLOADS["catalog.dataset.created.v1"]["dataset_id"]),
        ORG_B,
        None,
    ),
    "catalog.dataset.access_level_changed.v1": (
        "POLICY_CHANGED",
        "SUCCESS",
        "DATASET",
        UUID(PAYLOADS["catalog.dataset.created.v1"]["dataset_id"]),
        ORG_B,
        None,
    ),
    "catalog.dataset.policy_changed.v1": (
        "POLICY_CHANGED",
        "SUCCESS",
        "DATASET",
        UUID(PAYLOADS["catalog.dataset.created.v1"]["dataset_id"]),
        ORG_B,
        None,
    ),
    "catalog.dataset.metadata_changed.v1": (
        "DATASET_UPDATED",
        "SUCCESS",
        "DATASET",
        UUID(PAYLOADS["catalog.dataset.created.v1"]["dataset_id"]),
        ORG_B,
        None,
    ),
    "catalog.dataset.version_published.v1": (
        "DATASET_VERSION_PUBLISHED",
        "SUCCESS",
        "DATASET_VERSION",
        VERSION_ID,
        ORG_B,
        None,
    ),
    "governance.access.requested.v1": ("ACCESS_REQUESTED", "SUCCESS", "ACCESS_REQUEST", REQUEST_ID, ORG_B, P),
    "governance.access.review_started.v1": (
        "ACCESS_REVIEW_STARTED",
        "SUCCESS",
        "ACCESS_REQUEST",
        REQUEST_ID,
        ORG_B,
        P,
    ),
    "governance.access.approved.v1": ("ACCESS_APPROVED", "SUCCESS", "ACCESS_GRANT", GRANT_ID, ORG_B, P),
    "governance.access.rejected.v1": ("ACCESS_REJECTED", "SUCCESS", "ACCESS_REQUEST", REQUEST_ID, ORG_B, P),
    "governance.access.changes_requested.v1": (
        "ACCESS_CHANGES_REQUESTED",
        "SUCCESS",
        "ACCESS_REQUEST",
        REQUEST_ID,
        ORG_B,
        P,
    ),
    "governance.access.withdrawn.v1": ("ACCESS_WITHDRAWN", "SUCCESS", "ACCESS_REQUEST", REQUEST_ID, ORG_B, P),
    "governance.access.revoked.v1": ("ACCESS_REVOKED", "SUCCESS", "ACCESS_GRANT", GRANT_ID, ORG_B, P),
    "governance.access.expired.v1": ("ACCESS_EXPIRED", "SUCCESS", "ACCESS_GRANT", GRANT_ID, ORG_B, P),
    "governance.download.authorized.v1": (
        "FILE_DOWNLOADED",
        "SUCCESS",
        "DATASET_VERSION",
        VERSION_ID,
        ORG_B,
        P,
    ),
    "governance.download.denied.v1": ("DOWNLOAD_DENIED", "DENIED", "DATASET_VERSION", VERSION_ID, ORG_B, P),
    "readiness.validation.completed.v1": (
        "READINESS_VALIDATION_COMPLETED",
        "SUCCESS",
        "READINESS_VALIDATION",
        VALIDATION_ID,
        ORG_B,
        None,
    ),
}


# Contract 1.4.0 events (hub / workspace / research notes) whose audit rules are implemented in Task 8 of the
# 2026-10-02 data-hub plan. Task 8 maps each one (AUDIT_RULES or NOT_AUDITED) and empties this set.
PENDING_AUDIT_RULES: frozenset[str] = frozenset(
    {
        "workspace.input.added.v1",
        "workspace.input.version_changed.v1",
        "workspace.input.removed.v1",
        "workspace.recipe.saved.v1",
        "workspace.run.succeeded.v1",
        "workspace.run.failed.v1",
        "workspace.output.created.v1",
        "workspace.publish.requested.v1",
        "workspace.publish.decided.v1",
        "workspace.comment.added.v1",
        "notes.note.submitted.v1",
        "notes.note.signed.v1",
        "notes.note.rejected.v1",
        "notes.note.viewed.v1",
    }
)


def test_index_json_lists_exactly_the_42_consumed_types() -> None:
    index = json.loads((get_settings().contracts_dir / "events" / "index.json").read_text(encoding="utf-8"))
    types = {e["event_type"] for e in index["events"]}
    assert len(types) == 42
    assert types == set(AUDIT_RULES) | NOT_AUDITED | PENDING_AUDIT_RULES == {e.value for e in EventType}
    assert not set(AUDIT_RULES) & NOT_AUDITED
    assert not (set(AUDIT_RULES) | NOT_AUDITED) & PENDING_AUDIT_RULES


@pytest.mark.parametrize("event_type", [e.value for e in EventType])
def test_fixture_envelopes_are_contract_valid(event_type: str) -> None:
    assert_valid_event(as_json(envelope(event_type)))


@pytest.mark.parametrize("event_type", sorted(EXPECTED))
def test_mapping_matches_spec_table(event_type: str) -> None:
    event = envelope(event_type)
    record = to_audit_record(event)
    assert record is not None
    action, result, rtype, rid, owner, project = EXPECTED[event_type]
    assert (record.action, record.result, record.resource_type) == (action, result, rtype)
    assert record.resource_id == rid
    assert record.resource_owner_organization_id == owner
    assert record.project_id == project
    assert record.source_event_id == event.event_id
    assert record.source_event_type == event_type
    assert record.trace_id == event.correlation_id.hex
    assert record.occurred_at == event.occurred_at
    assert (record.actor_type, record.actor_user_id, record.actor_organization_id) == (
        "USER",
        A_RESEARCHER,
        ORG_A,
    )


@pytest.mark.parametrize("event_type", sorted(NOT_AUDITED))
def test_not_audited_events_map_to_none(event_type: str) -> None:
    assert to_audit_record(envelope(event_type)) is None


def test_required_actions_are_all_mapped() -> None:
    assert len(REQUIRED_ACTIONS) == 12
    assert {rule.action.value for rule in AUDIT_RULES.values()} >= REQUIRED_ACTIONS


@pytest.mark.parametrize(
    ("event_type", "reason"),
    [
        ("governance.access.rejected.v1", "목적이 불명확합니다"),
        ("governance.access.revoked.v1", "프로젝트 종료"),
        ("governance.access.changes_requested.v1", "연구 목적을 구체화해 주세요"),
        ("governance.download.denied.v1", "ACCESS_GRANT_EXPIRED"),
        ("governance.access.approved.v1", None),
    ],
)
def test_reason_sources(event_type: str, reason: str | None) -> None:
    record = to_audit_record(envelope(event_type))
    assert record is not None and record.reason == reason


def test_download_denied_is_denied_with_error_code_reason_and_reasons_in_details() -> None:  # M09-AT-12
    record = to_audit_record(envelope("governance.download.denied.v1"))
    assert record is not None
    assert (record.action, record.result, record.reason) == (
        "DOWNLOAD_DENIED",
        "DENIED",
        "ACCESS_GRANT_EXPIRED",
    )
    assert record.details["reasons"] == ["grant expired"]


def test_download_denied_with_null_owner() -> None:
    record = to_audit_record(
        envelope("governance.download.denied.v1", owner_organization_id=None, project_id=None)
    )
    assert record is not None and record.resource_owner_organization_id is None and record.project_id is None


@pytest.mark.parametrize("event_type", ["governance.access.approved.v1", "governance.download.authorized.v1"])
def test_policy_version_copied(event_type: str) -> None:
    record = to_audit_record(envelope(event_type))
    assert record is not None and record.policy_version == POLICY_VERSION


def test_policy_version_absent_elsewhere() -> None:
    record = to_audit_record(envelope("governance.access.requested.v1"))
    assert record is not None and record.policy_version is None


def test_system_actor() -> None:
    record = to_audit_record(envelope("governance.access.expired.v1", actor=SYSTEM))
    assert record is not None and (record.actor_type, record.actor_user_id) == ("SYSTEM", None)


def test_details_copy_payload_without_purpose_detail() -> None:  # M09-AT-16
    event = envelope("governance.access.requested.v1", purpose_detail="free text with secrets")
    record = to_audit_record(event)
    assert record is not None
    assert "purpose_detail" not in record.details
    assert record.details["purpose"] == "ACADEMIC_RESEARCH"
    assert sanitize_details({"a": {"purpose_detail": "x", "b": [{"purpose_detail": "y", "c": 1}]}}) == {
        "a": {"b": [{"c": 1}]}
    }
