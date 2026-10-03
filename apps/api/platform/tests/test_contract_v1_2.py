"""W1-D3: openapi 1.2.0 declares every status the Wave 1 modules return, plus the M10 optional fields.

The 1.2.0 edit script is historical (frozen); 1.3.0+ changes are hand edits checked by test_contract_v1_3.py.
"""

from typing import Any

import pytest
import yaml

from api.platform.settings import Settings
from api.platform.testing.contracts import assert_matches_response

ERROR_BODY = {"error": {"code": "NOT_FOUND", "message": "x", "trace_id": "0" * 32, "details": {}}}
EXPECTED = {
    "listOrganizationMembers": {"404"},
    "listUsers": {"422"},
    "updateProject": {"404", "422"},
    "archiveProject": {"404"},
    "addProjectMember": {"404"},
    "updateProjectMemberRole": {"404", "422"},
    "listProjects": {"422"},
    "searchDatasets": {"422", "503"},
    "updateDataset": {"404", "409"},
    "listDatasetVersions": {"404"},
    "createDatasetVersion": {"404"},
    "createUploadSession": {"404", "503"},
    "completeUploadSession": {"403", "404", "503"},
    "deleteDraftFile": {"503"},
    "publishDatasetVersion": {"404"},
    "startReadinessValidation": {"404", "503"},
    "getReadiness": {"503"},
}


def _spec() -> dict[str, Any]:
    spec: dict[str, Any] = yaml.safe_load(
        (Settings().contracts_dir / "openapi.yaml").read_text(encoding="utf-8")
    )
    return spec


def _operations(spec: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        op["operationId"]: op
        for item in spec["paths"].values()
        for method, op in item.items()
        if method in ("get", "post", "put", "patch", "delete")
    }


def test_contract_version_is_at_least_1_2_0() -> None:
    major, minor, _ = (int(p) for p in _spec()["info"]["version"].split("."))
    assert (major, minor) >= (1, 2)


def test_every_secured_operation_declares_401() -> None:
    ops = _operations(_spec())
    for op_id, op in ops.items():
        if op.get("security") == []:
            assert op_id in {"healthLive", "healthReady"}
            assert "401" not in op["responses"], op_id
        elif op.get("security") == [
            {"internalToken": []}
        ]:  # D-049: header token, 404 unset / 403 wrong, no 401
            assert "Internal" in op["tags"], op_id
            assert "401" not in op["responses"] and {"403", "404"} <= set(op["responses"]), op_id
        else:
            assert op["responses"]["401"] == {"$ref": "#/components/responses/Error"}, op_id


def test_every_cursor_operation_declares_422() -> None:
    ops = _operations(_spec())
    cursor_ops = [
        op_id
        for op_id, op in ops.items()
        if any(
            p.get("$ref") == "#/components/parameters/Cursor"
            or (p.get("in") == "query" and p.get("name") == "cursor")
            for p in op.get("parameters", [])
        )
    ]
    assert cursor_ops
    for op_id in cursor_ops:
        assert ops[op_id]["responses"]["422"] == {"$ref": "#/components/responses/Error"}, op_id


@pytest.mark.parametrize(("op_id", "codes"), sorted(EXPECTED.items()))
def test_module_error_statuses_are_declared(op_id: str, codes: set[str]) -> None:
    op = _operations(_spec())[op_id]
    for code in codes:
        assert op["responses"][code]["$ref"] == "#/components/responses/Error", (op_id, code)
        assert_matches_response(op_id, int(code), ERROR_BODY)


def test_upload_session_upload_is_optional_but_shaped() -> None:
    files = _spec()["components"]["schemas"]["UploadSession"]["properties"]["files"]["items"]
    assert files["required"] == ["file_id", "path", "status"]
    methods = [variant["properties"]["method"]["const"] for variant in files["properties"]["upload"]["oneOf"]]
    assert methods == ["PUT", "MULTIPART"]


def test_m10_optional_display_fields() -> None:
    schemas = _spec()["components"]["schemas"]
    for schema, field in (
        ("AccessGrant", "subject_display_name"),
        ("AccessGrant", "project_name"),
        ("ProjectSummary", "lead_organization_name"),
    ):
        assert schemas[schema]["properties"][field] == {"type": "string"}
        assert field not in schemas[schema]["required"]


def test_generated_models_have_the_optional_fields() -> None:
    from nais_contracts.api_models import AccessGrant, ProjectSummary

    assert AccessGrant.model_fields["subject_display_name"].is_required() is False
    assert AccessGrant.model_fields["project_name"].is_required() is False
    assert ProjectSummary.model_fields["lead_organization_name"].is_required() is False
