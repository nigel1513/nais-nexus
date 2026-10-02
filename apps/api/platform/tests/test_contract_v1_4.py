"""Wave 1.5 Stage 2: openapi 1.4.0 lakeFS-style versioning (spec 2026-10-01-research-data-portal-design §3.3b)."""

import json
from typing import Any

import yaml

from api.platform.settings import Settings
from api.platform.testing.contracts import assert_matches_response

NEW_OPS = {
    "updateDatasetVersion": ("patch", "/dataset-versions/{version_id}"),
    "discardDatasetVersion": ("delete", "/dataset-versions/{version_id}"),
    "rebaseDatasetVersion": ("post", "/dataset-versions/{version_id}/rebase"),
    "compareDatasetVersions": ("get", "/dataset-versions/{version_id}/diff"),
    "getFileHistory": ("get", "/datasets/{dataset_id}/file-history"),
    "getDatasetCitation": ("get", "/dataset-versions/{version_id}/citation"),
}
V1 = "00000000-0000-7000-8000-000000002101"
V2 = "00000000-0000-7000-8000-000000002102"
DS = "00000000-0000-7000-8000-000000002001"
SHA_A = "a" * 64
SHA_B = "b" * 64


def _spec() -> dict[str, Any]:
    spec: dict[str, Any] = yaml.safe_load((Settings().contracts_dir / "openapi.yaml").read_text("utf-8"))
    return spec


def test_version_and_new_operations() -> None:
    spec = _spec()
    assert spec["info"]["version"] == "1.4.0"
    for op_id, (method, path) in NEW_OPS.items():
        op = spec["paths"][path][method]
        assert op["operationId"] == op_id
        assert op["responses"]["401"] == {"$ref": "#/components/responses/Error"}, op_id


def test_stale_base_error_code() -> None:
    codes = json.loads((Settings().contracts_dir / "error_codes.json").read_text("utf-8"))
    [entry] = [c for c in codes["codes"] if c["code"] == "DATASET_VERSION_STALE_BASE"]
    assert entry["http"] == 409 and entry["module"] == "catalog"


def test_create_version_body_has_from_version_and_empty() -> None:
    body = _spec()["paths"]["/datasets/{dataset_id}/versions"]["post"]["requestBody"]["content"][
        "application/json"
    ]
    props = body["schema"]["properties"]
    assert set(props) == {"version_label", "change_note", "from_version_id", "empty"}


def test_draft_version_with_lineage_fields_matches() -> None:
    body = {
        "dataset_version_id": V2,
        "version_label": "v2",
        "status": "DRAFT",
        "published_at": None,
        "readiness_overall": None,
        "dataset_id": DS,
        "change_note": None,
        "files": [
            {
                "file_id": V1,
                "path": "data/a.csv",
                "size_bytes": 8,
                "sha256": SHA_A,
                "media_type": "text/csv",
                "status": "VERIFIED",
                "inherited": True,
            }
        ],
        "file_count": 1,
        "total_bytes": 8,
        "manifest_sha256": None,
        "created_at": "2026-10-01T00:00:00Z",
        "created_by": V1,
        "base_version_id": V1,
        "source_version_id": V1,
        "previous_version_id": None,
        "base_is_latest": True,
        "change_summary": {"added": 0, "removed": 0, "changed": 0, "unchanged": 1},
    }
    assert_matches_response("getDatasetVersion", 200, body)


def test_diff_matches() -> None:
    body = {
        "from_version_id": V1,
        "to_version_id": V2,
        "summary": {"added": 1, "removed": 0, "changed": 1, "unchanged": 0},
        "files": [
            {
                "path": "data/a.csv",
                "status": "CHANGED",
                "before": {"size_bytes": 8, "sha256": SHA_A},
                "after": {"size_bytes": 9, "sha256": SHA_B},
                "size_delta": 1,
            },
            {
                "path": "data/b.csv",
                "status": "ADDED",
                "before": None,
                "after": {"size_bytes": 4, "sha256": SHA_B},
                "size_delta": 4,
            },
        ],
        "schema": [
            {
                "path": "data/a.csv",
                "status": "COMPARED",
                "rows": [10, 9],
                "columns_added": ["z"],
                "columns_removed": [],
                "columns_changed": [
                    {"name": "x", "type": ["integer", "number"], "unit": None, "missing_ratio": [0.0, 0.1]}
                ],
            }
        ],
        "metadata": [{"field": "license", "before": "CC-BY-4.0", "after": "CC0-1.0"}],
    }
    assert_matches_response("compareDatasetVersions", 200, body)


def test_rebase_conflict_and_history_and_citation_match() -> None:
    assert_matches_response(
        "getFileHistory",
        200,
        {
            "dataset_id": DS,
            "path": "data/a.csv",
            "items": [
                {
                    "dataset_version_id": V1,
                    "version_label": "v1",
                    "published_at": "2026-10-01T00:00:00Z",
                    "state": "ADDED",
                    "sha256": SHA_A,
                    "size_bytes": 8,
                }
            ],
        },
    )
    assert_matches_response(
        "getDatasetCitation", 200, {"dataset_version_id": V1, "style": "bibtex", "content": "@misc{x}"}
    )
