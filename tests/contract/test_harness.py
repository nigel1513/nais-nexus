import uuid

import pytest
from api.platform.testing.contracts import assert_matches_response, assert_valid_event, operation

PROJECT = {
    "project_id": "0192f0c0-0000-7000-8000-000000000001",
    "name": "Battery study",
    "status": "ACTIVE",
    "visibility": "PRIVATE",
    "lead_organization_id": "0192f0c0-0000-7000-8000-00000000000a",
    "description": "d",
    "organizations": [],
    "created_at": "2026-09-30T00:00:00Z",
}


def test_operation_lookup() -> None:
    assert operation("getProject") == ("/projects/{project_id}", "get")


def test_valid_body_passes() -> None:
    assert_matches_response("getProject", 200, PROJECT)


def test_contract_violation_fails_with_readable_message() -> None:
    with pytest.raises(AssertionError, match="DELETED"):
        assert_matches_response("getProject", 200, {**PROJECT, "status": "DELETED"})


def test_error_envelope_is_checked_through_shared_response_refs() -> None:
    body = {"error": {"code": "NOT_FOUND", "message": "x", "trace_id": "0" * 32}}
    assert_matches_response("getProject", 404, body)
    with pytest.raises(AssertionError):
        assert_matches_response("getProject", 404, {"error": {"code": "NOT_FOUND"}})


def test_undeclared_status_and_unknown_operation_fail() -> None:
    with pytest.raises(AssertionError, match="no 418 response"):
        assert_matches_response("getProject", 418, {})
    with pytest.raises(AssertionError, match="unknown operationId"):
        assert_matches_response("launchRocket", 200, {})


def test_no_content_responses() -> None:
    assert_matches_response("removeProjectMember", 204, None)


def test_event_validation() -> None:
    event = {
        "event_id": str(uuid.uuid4()),
        "event_type": "project.archived.v1",
        "occurred_at": "2026-09-30T00:00:00Z",
        "producer": "project",
        "correlation_id": str(uuid.uuid4()),
        "actor": {"type": "SYSTEM", "user_id": None, "organization_id": None},
        "payload": {"project_id": str(uuid.uuid4())},
    }
    assert_valid_event(event)
    with pytest.raises(AssertionError):
        assert_valid_event({**event, "producer": "catalog"})
