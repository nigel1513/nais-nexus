"""compareDatasetVersions and change_summary (spec §3.3, §3.3b; Review Focus 3)."""

import json
from typing import Any

import pytest

from api.modules.catalog.service import diff as diff_service
from api.modules.catalog.tests.support import execute
from api.modules.catalog.tests.support_api import CatalogApi, assert_error, new_draft
from api.modules.catalog.tests.support_upload import upload_files
from api.modules.catalog.tests.test_versioning_drafts import draft, first_published, publish
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


def _diff(api: CatalogApi, version_id: str, user: str = "b.steward", **params: Any) -> dict[str, Any]:
    response = api.get(user, f"/dataset-versions/{version_id}/diff", params=params)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    assert_matches_response("compareDatasetVersions", 200, body)
    return body


def _ready(db: PgUrls, version_id: str, profile: dict[str, Any], preview: str = '{"rows": []}') -> None:
    execute(
        db,
        "UPDATE catalog.file_previews SET status = 'READY', generated_at = now(), column_profile = CAST(:p AS jsonb),"
        " preview = CAST(:r AS jsonb) WHERE file_id IN (SELECT file_id FROM catalog.dataset_files"
        " WHERE dataset_version_id = :v)",
        p=json.dumps(profile),
        r=preview,
        v=version_id,
    )


def _profile(*columns: dict[str, Any], total_rows: int = 1) -> dict[str, Any]:
    return {
        "format": "csv",
        "rows_sampled": total_rows,
        "total_rows": total_rows,
        "truncated": False,
        "columns_truncated": False,
        "columns": [
            {
                "unit": None,
                "missing_ratio": 0,
                "distinct_count": 1,
                "description": None,
                "concept_iri": None,
                **c,
            }
            for c in columns
        ],
    }


def test_draft_diff_defaults_to_base_and_list_has_summary(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, v1 = first_published(api, db)
    vid = draft(api, dataset_id, "v2")["dataset_version_id"]
    upload_files(api, db, vid, {"data/a.csv": b"x,y\n7,7\n", "data/b.csv": b"b\n1\n"})
    readme = next(
        f
        for f in api.get("b.steward", f"/dataset-versions/{vid}").json()["files"]
        if f["path"] == "README.md"
    )
    assert api.delete("b.steward", f"/dataset-versions/{vid}/files/{readme['file_id']}").status_code == 204
    body = _diff(api, vid)
    assert body["from_version_id"] == v1 and body["to_version_id"] == vid
    assert body["summary"] == {"added": 1, "removed": 1, "changed": 1, "unchanged": 0}
    assert [(f["path"], f["status"]) for f in body["files"]] == [
        ("README.md", "REMOVED"),
        ("data/a.csv", "CHANGED"),
        ("data/b.csv", "ADDED"),
    ]
    # The new upload has no profile yet: unknown, not "every column removed".
    assert body["schema"] == [{"path": "data/a.csv", "status": "PROFILE_MISSING"}]
    items = {
        v["dataset_version_id"]: v
        for v in api.get("b.steward", f"/datasets/{dataset_id}/versions").json()["items"]
    }
    assert items[vid]["change_summary"] == body["summary"]
    assert items[v1]["change_summary"] is None  # the first version has nothing to compare with
    assert api.get("b.steward", f"/dataset-versions/{vid}").json()["change_summary"] == body["summary"]


def test_first_version_compares_with_nothing(api: CatalogApi, db: PgUrls) -> None:
    _, v1 = new_draft(api)
    upload_files(api, db, v1, {"data/a.csv": b"x\n1\n"})
    body = _diff(api, v1)
    assert body["from_version_id"] is None
    assert body["summary"] == {"added": 1, "removed": 0, "changed": 0, "unchanged": 0}
    assert body["schema"] == [] and body["metadata"]  # every live field is "added"
    assert api.get("b.steward", f"/dataset-versions/{v1}").json()["change_summary"] is None


def test_published_summary_is_against_previous(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, v1 = first_published(api, db)
    v2 = draft(api, dataset_id, "v2")["dataset_version_id"]
    upload_files(api, db, v2, {"data/a.csv": b"x,y\n5,6\n"})
    publish(api, v2)
    revert = draft(api, dataset_id, "v3", from_version_id=v1)["dataset_version_id"]
    items = {
        v["dataset_version_id"]: v
        for v in api.get("b.steward", f"/datasets/{dataset_id}/versions").json()["items"]
    }
    assert items[v2]["change_summary"] == {"added": 0, "removed": 0, "changed": 1, "unchanged": 1}
    assert items[revert]["change_summary"] == {"added": 0, "removed": 0, "changed": 1, "unchanged": 1}
    assert _diff(api, revert)["from_version_id"] == v2  # a revert draft compares with its base (latest)
    assert _diff(api, revert, against=v1)["summary"] == {
        "added": 0,
        "removed": 0,
        "changed": 0,
        "unchanged": 2,
    }
    for vid in (v2, revert):  # the SQL summary agrees with the full comparison
        assert items[vid]["change_summary"] == _diff(api, vid)["summary"]


def test_metadata_layer_between_published_versions(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, v1 = first_published(api, db)
    assert api.patch("b.steward", f"/datasets/{dataset_id}", json={"license": "CC0-1.0"}).status_code == 200
    v2 = draft(api, dataset_id, "v2")["dataset_version_id"]
    # A draft compares with the live metadata publishing would freeze.
    assert {"field": "license", "before": "CC-BY-4.0", "after": "CC0-1.0"} in _diff(api, v2)["metadata"]
    publish(api, v2)
    body = _diff(api, v2, user="b.researcher")
    assert {"field": "license", "before": "CC-BY-4.0", "after": "CC0-1.0"} in body["metadata"]
    assert all(m["field"] != "license" or m["after"] == "CC0-1.0" for m in body["metadata"])
    assert body["summary"]["unchanged"] == 2
    assert "@" not in json.dumps(body["metadata"])  # no private email in either snapshot


def test_schema_layer_has_no_raw_values(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, v1 = first_published(api, db)
    v2 = draft(api, dataset_id, "v2")["dataset_version_id"]
    upload_files(api, db, v2, {"data/a.csv": b"x,y\n1,SECRETVALUE\n"})
    publish(api, v2)
    raw = '{"header": ["y"], "rows": [["SECRETVALUE"]], "rows_truncated": false, "columns": []}'
    _ready(db, v1, _profile({"name": "y", "type": "integer", "min": "SECRETVALUE"}), raw)
    _ready(db, v2, _profile({"name": "y", "type": "string", "top_values": [{"value": "SECRETVALUE"}]}), raw)
    # a.researcher can see Institute B's CONTROLLED dataset metadata (D-012) but has no download permission.
    response = api.get("a.researcher", f"/dataset-versions/{v2}/diff")
    assert response.status_code == 200, response.text
    assert "SECRETVALUE" not in response.text
    [schema] = [s for s in response.json()["schema"] if s["path"] == "data/a.csv"]
    assert schema == {
        "path": "data/a.csv",
        "status": "COMPARED",
        "rows": [1, 1],
        "columns_added": [],
        "columns_removed": [],
        "columns_changed": [
            {"name": "y", "type": ["integer", "string"], "unit": None, "missing_ratio": None}
        ],
    }


def test_inherited_rows_use_their_source_profile(
    api: CatalogApi, db: PgUrls, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A draft's inherited row has no preview of its own: the profile of the row it inherits from is used."""
    dataset_id, v1 = first_published(api, db)
    v2 = draft(api, dataset_id, "v2")["dataset_version_id"]
    upload_files(api, db, v2, {"data/a.csv": b"x,y,z\n1,2,3\n", "data/c.csv": b"c\n1\n"})
    publish(api, v2)
    _ready(db, v1, _profile({"name": "x", "type": "integer"}, {"name": "y", "type": "integer"}))
    _ready(db, v2, _profile({"name": "x", "type": "integer"}, {"name": "z", "type": "integer"}, total_rows=2))
    v3 = draft(api, dataset_id, "v3")["dataset_version_id"]  # inherits v2's rows: no preview rows of its own
    monkeypatch.setattr(diff_service, "SCHEMA_CHUNK", 1)  # exercise the chunked profile reads
    body = _diff(api, v3, against=v1)
    assert body["schema"] == [
        {
            "path": "data/a.csv",
            "status": "COMPARED",
            "rows": [1, 2],
            "columns_added": ["z"],
            "columns_removed": ["y"],
            "columns_changed": [],
        }
    ]


def test_against_must_be_same_dataset_and_visible(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, v1 = first_published(api, db)
    _, other = first_published(api, db)
    response = api.get("b.steward", f"/dataset-versions/{v1}/diff", params={"against": other})
    error = assert_error("compareDatasetVersions", response, 422, "VALIDATION_FAILED")
    assert error["details"]["fields"] == [{"field": "against", "reason": "DIFFERENT_DATASET"}]
    v2 = draft(api, dataset_id, "v2")["dataset_version_id"]
    response = api.get("a.researcher", f"/dataset-versions/{v1}/diff", params={"against": v2})
    assert_error("compareDatasetVersions", response, 404, "NOT_FOUND")  # an invisible draft is never revealed
    response = api.get(
        "b.steward",
        f"/dataset-versions/{v1}/diff",
        params={"against": "00000000-0000-7000-8000-000000000000"},
    )
    assert_error("compareDatasetVersions", response, 404, "NOT_FOUND")
    assert_error(
        "compareDatasetVersions", api.get("a.researcher", f"/dataset-versions/{v2}/diff"), 404, "NOT_FOUND"
    )
    response = api.get("b.steward", f"/dataset-versions/{v1}/diff", params={"against": "nope"})
    assert_error("compareDatasetVersions", response, 422, "VALIDATION_FAILED")


def test_withdrawn_predecessor_is_404_for_those_who_cannot_see_it(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, v1 = first_published(api, db)
    v2 = draft(api, dataset_id, "v2")["dataset_version_id"]
    publish(api, v2)
    execute(
        db, "UPDATE catalog.dataset_versions SET status = 'WITHDRAWN' WHERE dataset_version_id = :v", v=v1
    )
    # Default target (previous_version_id = the withdrawn v1) and the explicit one behave the same.
    assert_error(
        "compareDatasetVersions", api.get("a.researcher", f"/dataset-versions/{v2}/diff"), 404, "NOT_FOUND"
    )
    response = api.get("a.researcher", f"/dataset-versions/{v2}/diff", params={"against": v1})
    assert_error("compareDatasetVersions", response, 404, "NOT_FOUND")
    assert _diff(api, v2)["from_version_id"] == v1  # the owner's steward still sees it


def test_summary_against_an_invisible_target_is_null_for_that_caller(api: CatalogApi, db: PgUrls) -> None:
    """Ruling S10: v3's predecessor v2 is WITHDRAWN; a researcher cannot see it, so v3 has no change_summary for
    them (and /diff with the default target is 404); the steward still sees the counts."""
    dataset_id, v1 = first_published(api, db)
    v2 = draft(api, dataset_id, "v2")["dataset_version_id"]
    upload_files(api, db, v2, {"data/a.csv": b"x,y\n5,6\n"})
    publish(api, v2)
    v3 = draft(api, dataset_id, "v3")["dataset_version_id"]
    upload_files(api, db, v3, {"data/c.csv": b"c\n1\n"})
    publish(api, v3)
    execute(
        db, "UPDATE catalog.dataset_versions SET status = 'WITHDRAWN' WHERE dataset_version_id = :v", v=v2
    )
    expected = {"added": 1, "removed": 0, "changed": 0, "unchanged": 2}
    for user, summary in (("b.researcher", None), ("a.researcher", None), ("b.steward", expected)):
        items = {
            v["dataset_version_id"]: v
            for v in api.get(user, f"/datasets/{dataset_id}/versions").json()["items"]
        }
        assert items[v3]["change_summary"] == summary, user
        assert api.get(user, f"/dataset-versions/{v3}").json()["change_summary"] == summary, user
    assert_error(
        "compareDatasetVersions", api.get("b.researcher", f"/dataset-versions/{v3}/diff"), 404, "NOT_FOUND"
    )
    assert _diff(api, v3)["summary"] == expected


def test_published_side_without_snapshot_reports_no_metadata_changes() -> None:
    """ck_versions_published forbids it today; a missing frozen snapshot is unknown, never "everything changed"."""
    from api.modules.catalog.service.diff import _metadata_layer

    published = {"status": "PUBLISHED", "metadata_snapshot": {"title": "T", "license": "CC0-1.0"}}
    missing = {"status": "PUBLISHED", "metadata_snapshot": None}
    assert _metadata_layer(None, None, missing, published, {}) == []  # type: ignore[arg-type]
    assert _metadata_layer(None, None, published, missing, {}) == []  # type: ignore[arg-type]
    assert _metadata_layer(None, None, None, published, {}) == [  # type: ignore[arg-type]
        {"field": "license", "before": None, "after": "CC0-1.0"},
        {"field": "title", "before": None, "after": "T"},
    ]
