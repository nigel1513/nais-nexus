"""Zero-copy drafts (spec §3.3b): branch, revert, several drafts, discard (Review Focus 4)."""

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import select

from api.modules.catalog.service.versions import discard_version
from api.modules.catalog.tables import dataset_files
from api.modules.catalog.testing import memory_store
from api.modules.catalog.tests.support import execute, rows
from api.modules.catalog.tests.support_api import USERS, CatalogApi, assert_error, new_draft
from api.modules.catalog.tests.support_upload import start_upload, upload_files
from api.modules.catalog.versioning.inherit import copy_rows
from api.modules.catalog.versioning.refs import InheritanceViolation, StorageCleanup
from api.platform.db import session_factory
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls

A1 = {"data/a.csv": b"x,y\n1,2\n", "README.md": b"# v1\n"}


def publish(api: CatalogApi, version_id: str, note: str = "change note") -> dict[str, Any]:
    response = api.patch("b.steward", f"/dataset-versions/{version_id}", json={"change_note": note})
    assert response.status_code == 200, response.text
    response = api.post("b.steward", f"/dataset-versions/{version_id}/publish")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def draft(api: CatalogApi, dataset_id: str, label: str, **extra: Any) -> dict[str, Any]:
    response = api.post(
        "b.steward", f"/datasets/{dataset_id}/versions", json={"version_label": label, **extra}
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    assert_matches_response("createDatasetVersion", 201, body)
    return body


def first_published(api: CatalogApi, db: PgUrls) -> tuple[str, str]:
    dataset_id, v1 = new_draft(api)
    upload_files(api, db, v1, A1)
    publish(api, v1)
    return dataset_id, v1


def _store(api: CatalogApi) -> dict[str, bytes]:
    objects: dict[str, bytes] = memory_store(api.deps.storage, "inst-b").objects
    return objects


def _store_uploads(api: CatalogApi) -> dict[str, Any]:
    uploads: dict[str, Any] = memory_store(api.deps.storage, "inst-b").uploads
    return uploads


def test_first_draft_has_no_base(api: CatalogApi) -> None:
    _, v1 = new_draft(api)
    body = api.get("b.steward", f"/dataset-versions/{v1}").json()
    assert body["base_version_id"] is None and body["source_version_id"] is None
    assert body["previous_version_id"] is None and body["base_is_latest"] is True
    assert body["change_summary"] is None and body["created_by"]


def test_new_draft_inherits_without_reupload(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, v1 = first_published(api, db)
    v2 = draft(api, dataset_id, "v2")
    assert v2["base_version_id"] == v1 and v2["source_version_id"] == v1 and v2["base_is_latest"] is True
    assert {(f["path"], f["status"], f["inherited"]) for f in v2["files"]} == {
        ("README.md", "VERIFIED", True),
        ("data/a.csv", "VERIFIED", True),
    }
    assert v2["file_count"] == 2
    pairs = rows(
        db,
        "SELECT a.storage_key AS k1, b.storage_key AS k2, b.upload_session_id AS s FROM catalog.dataset_files a"
        " JOIN catalog.dataset_files b ON b.inherited_from_file_id = a.file_id WHERE b.dataset_version_id = :v",
        v=v2["dataset_version_id"],
    )
    assert len(pairs) == 2 and all(p["k1"] == p["k2"] and p["s"] is None for p in pairs)
    # The published version reports its own files as not inherited, and the base_is_latest flag only on drafts.
    v1_body = api.get("b.steward", f"/dataset-versions/{v1}").json()
    assert all(f["inherited"] is False for f in v1_body["files"]) and v1_body["base_is_latest"] is None


def test_empty_draft_is_based_on_latest(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, v1 = first_published(api, db)
    v2 = draft(api, dataset_id, "v2", empty=True)
    assert v2["files"] == [] and v2["base_version_id"] == v1 and v2["source_version_id"] is None


def test_several_drafts_coexist(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, v1 = first_published(api, db)
    a = draft(api, dataset_id, "v2-a")
    b = draft(api, dataset_id, "v2-b")
    items = api.get("b.steward", f"/datasets/{dataset_id}/versions").json()["items"]
    by_label = {v["version_label"]: v for v in items}
    assert {"v2-a", "v2-b"} <= set(by_label)
    for label in ("v2-a", "v2-b"):
        assert by_label[label]["base_version_id"] == v1 and by_label[label]["base_is_latest"] is True
    # Both point at the same stored objects as v1.
    keys = rows(
        db,
        "SELECT dataset_version_id AS v, storage_key FROM catalog.dataset_files WHERE dataset_version_id IN"
        " (:a, :b, :v1)",
        a=a["dataset_version_id"],
        b=b["dataset_version_id"],
        v1=v1,
    )
    assert len(keys) == 6 and len({k["storage_key"] for k in keys}) == 2


def test_draft_base_is_latest_turns_false_after_another_publish(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, _ = first_published(api, db)
    a = draft(api, dataset_id, "v2-a")
    b = draft(api, dataset_id, "v2-b")
    publish(api, b["dataset_version_id"])
    body = api.get("b.steward", f"/dataset-versions/{a['dataset_version_id']}").json()
    assert body["base_is_latest"] is False
    listed = {
        v["version_label"]: v
        for v in api.get("b.steward", f"/datasets/{dataset_id}/versions").json()["items"]
    }
    assert listed["v2-a"]["base_is_latest"] is False and listed["v2-b"]["base_is_latest"] is None


def test_revert_draft_is_based_on_latest_and_shows_changes(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, v1 = first_published(api, db)
    v2 = draft(api, dataset_id, "v2")
    upload_files(api, db, v2["dataset_version_id"], {"data/a.csv": b"x,y\n5,6\n"})
    publish(api, v2["dataset_version_id"])
    revert = draft(api, dataset_id, "v3", from_version_id=v1)
    assert revert["base_version_id"] == v2["dataset_version_id"] and revert["source_version_id"] == v1
    assert revert["base_is_latest"] is True
    shas = {f["path"]: f["sha256"] for f in revert["files"]}
    v1_shas = {
        f["path"]: f["sha256"] for f in api.get("b.steward", f"/dataset-versions/{v1}").json()["files"]
    }
    assert shas == v1_shas
    sources = rows(
        db,
        "SELECT s.dataset_version_id AS v FROM catalog.dataset_files d JOIN catalog.dataset_files s"
        " ON s.file_id = d.inherited_from_file_id WHERE d.dataset_version_id = :v",
        v=revert["dataset_version_id"],
    )
    assert {str(s["v"]) for s in sources} == {v1}


def test_from_version_must_be_published_and_same_dataset(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, v1 = first_published(api, db)
    other_dataset, other_draft = new_draft(api)
    other_published = first_published(api, db)[1]
    for bad in (other_draft, other_published, "00000000-0000-0000-0000-000000000000"):
        response = api.post(
            "b.steward",
            f"/datasets/{dataset_id}/versions",
            json={"version_label": "x", "from_version_id": bad},
        )
        error = assert_error("createDatasetVersion", response, 422, "VALIDATION_FAILED")
        assert error["details"]["fields"] == [{"field": "from_version_id", "reason": "VERSION_NOT_PUBLISHED"}]
    own_draft = draft(api, dataset_id, "own-draft")["dataset_version_id"]
    response = api.post(
        "b.steward",
        f"/datasets/{dataset_id}/versions",
        json={"version_label": "z", "from_version_id": own_draft},
    )
    error = assert_error("createDatasetVersion", response, 422, "VALIDATION_FAILED")
    assert error["details"]["fields"] == [{"field": "from_version_id", "reason": "VERSION_NOT_PUBLISHED"}]
    response = api.post(
        "b.steward",
        f"/datasets/{dataset_id}/versions",
        json={"version_label": "y", "from_version_id": v1, "empty": True},
    )
    error = assert_error("createDatasetVersion", response, 422, "VALIDATION_FAILED")
    assert error["details"]["fields"] == [{"field": "empty", "reason": "MUTUALLY_EXCLUSIVE"}]
    labels = {
        v["version_label"] for v in api.get("b.steward", f"/datasets/{dataset_id}/versions").json()["items"]
    }
    assert labels == {"v1", "own-draft"}  # nothing was created by the rejected calls


def test_copy_rows_refuses_non_published_sources(api: CatalogApi, db: PgUrls) -> None:
    """Protocol (a): only PUBLISHED rows of the same dataset are copied, checked in the inserting transaction."""
    dataset_id, v1 = first_published(api, db)
    own = draft(api, dataset_id, "v2", empty=True)["dataset_version_id"]
    upload_files(api, db, own, {"data/own.csv": b"o\n1\n"})
    target = draft(api, dataset_id, "v3", empty=True)["dataset_version_id"]
    other_dataset, other_v1 = first_published(api, db)
    now = datetime.now(UTC)
    for source_version in (own, other_v1):
        with session_factory(db.app)() as session, session.begin():
            src = (
                session.execute(
                    select(dataset_files).where(dataset_files.c.dataset_version_id == UUID(source_version))
                )
                .mappings()
                .all()
            )
            with pytest.raises(InheritanceViolation):
                copy_rows(session, src, to_version_id=UUID(target), now=now)
    assert rows(db, "SELECT 1 FROM catalog.dataset_files WHERE dataset_version_id = :v", v=target) == []


def test_update_change_note_draft_only(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, v1 = first_published(api, db)
    response = api.patch("b.steward", f"/dataset-versions/{v1}", json={"change_note": "nope"})
    assert_error("updateDatasetVersion", response, 409, "DATASET_VERSION_IMMUTABLE")
    v2 = draft(api, dataset_id, "v2")["dataset_version_id"]
    response = api.patch("b.steward", f"/dataset-versions/{v2}", json={"change_note": "  ok!  "})
    assert response.status_code == 200, response.text
    assert_matches_response("updateDatasetVersion", 200, response.json())
    assert response.json()["change_note"] == "ok!" and response.json()["files"]
    for bad in ("  ", "ab", "x" * 2001, None):
        response = api.patch("b.steward", f"/dataset-versions/{v2}", json={"change_note": bad})
        assert_error("updateDatasetVersion", response, 422, "VALIDATION_FAILED")
    assert_error(
        "updateDatasetVersion",
        api.patch("b.steward", f"/dataset-versions/{v2}", json={"change_note": "abc", "extra": 1}),
        422,
        "VALIDATION_FAILED",
    )
    assert (
        api.patch("b.steward", f"/dataset-versions/{v2}", json={"change_note": "x" * 2000}).status_code == 200
    )
    # Invisible draft -> 404; a visible version the user may not change -> 403.
    response = api.patch("b.researcher", f"/dataset-versions/{v2}", json={"change_note": "abc"})
    assert_error("updateDatasetVersion", response, 404, "NOT_FOUND")
    response = api.patch("b.researcher", f"/dataset-versions/{v1}", json={"change_note": "abc"})
    assert_error("updateDatasetVersion", response, 403, "FORBIDDEN")


def test_discard_draft_keeps_shared_objects(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, v1 = first_published(api, db)
    v2 = draft(api, dataset_id, "v2")["dataset_version_id"]
    upload_files(api, db, v2, {"data/new.csv": b"n\n1\n"})
    [new] = rows(
        db,
        "SELECT storage_key FROM catalog.dataset_files WHERE dataset_version_id = :v AND path = 'data/new.csv'",
        v=v2,
    )
    assert new["storage_key"] in _store(api)
    response = api.delete("b.steward", f"/dataset-versions/{v2}")
    assert response.status_code == 204, response.text
    assert rows(db, "SELECT 1 FROM catalog.dataset_versions WHERE dataset_version_id = :v", v=v2) == []
    assert rows(db, "SELECT 1 FROM catalog.dataset_files WHERE dataset_version_id = :v", v=v2) == []
    assert rows(db, "SELECT 1 FROM catalog.upload_sessions WHERE dataset_version_id = :v", v=v2) == []
    assert new["storage_key"] not in _store(api)  # only the draft referenced it
    for f in api.get("b.steward", f"/dataset-versions/{v1}").json()["files"]:
        [key] = rows(db, "SELECT storage_key FROM catalog.dataset_files WHERE file_id = :f", f=f["file_id"])
        assert key["storage_key"] in _store(api)  # v1 objects untouched
    assert api.get("b.steward", f"/dataset-versions/{v2}").status_code == 404
    # The label is free again.
    draft(api, dataset_id, "v2")


def test_discard_draft_with_open_upload_and_preview_rows(api: CatalogApi, db: PgUrls) -> None:
    """Protocol (c): preview rows go before file rows; PENDING rows of an open session are dropped too, and their
    objects (single PUT already landed, or an open multipart upload) are cleanup targets."""
    dataset_id, _ = first_published(api, db)
    v2 = draft(api, dataset_id, "v2")["dataset_version_id"]
    start_upload(api, v2, {"data/pending.csv": b"p\n1\n"})
    big = {
        "path": "data/big.csv",
        "size_bytes": 100 * 1024 * 1024,
        "sha256": "a" * 64,
        "media_type": "text/csv",
    }
    response = api.post("b.steward", f"/dataset-versions/{v2}/upload-session", json={"files": [big]})
    assert response.status_code == 201, response.text
    pending = {
        r["path"]: r
        for r in rows(
            db,
            "SELECT * FROM catalog.dataset_files WHERE dataset_version_id = :v AND status = 'PENDING'",
            v=v2,
        )
    }
    single, multi = pending["data/pending.csv"], pending["data/big.csv"]
    assert single["multipart_upload_id"] is None and multi["multipart_upload_id"] in _store_uploads(api)
    _store(api)[single["storage_key"]] = b"p\n1\n"  # the client's PUT landed before the discard
    [inherited, *_] = rows(
        db,
        "SELECT file_id FROM catalog.dataset_files WHERE dataset_version_id = :v AND upload_session_id IS NULL",
        v=v2,
    )
    execute(
        db,
        "INSERT INTO catalog.file_previews (file_id, dataset_version_id, status) VALUES (:f, :v, 'PENDING')",
        f=inherited["file_id"],
        v=v2,
    )
    with session_factory(db.app)() as session, session.begin():
        cleanups = discard_version(session, api.deps, USERS["b.steward"], UUID(v2))
        assert set(cleanups) == {
            StorageCleanup(single["storage_bucket"], single["storage_key"], None),
            StorageCleanup(multi["storage_bucket"], multi["storage_key"], multi["multipart_upload_id"]),
        }  # inherited rows share v1's objects: no target for them
        session.rollback()
    assert api.delete("b.steward", f"/dataset-versions/{v2}").status_code == 204
    assert rows(db, "SELECT 1 FROM catalog.file_previews WHERE dataset_version_id = :v", v=v2) == []
    assert rows(db, "SELECT 1 FROM catalog.dataset_files WHERE dataset_version_id = :v", v=v2) == []
    assert single["storage_key"] not in _store(api)
    assert multi["multipart_upload_id"] not in _store_uploads(api)  # aborted after commit


def test_discard_first_draft_removes_its_objects(api: CatalogApi, db: PgUrls) -> None:
    _, v1 = new_draft(api)
    upload_files(api, db, v1, A1)
    keys = [
        r["storage_key"]
        for r in rows(db, "SELECT storage_key FROM catalog.dataset_files WHERE dataset_version_id = :v", v=v1)
    ]
    assert api.delete("b.steward", f"/dataset-versions/{v1}").status_code == 204
    assert all(k not in _store(api) for k in keys)


def test_discard_published_is_immutable(api: CatalogApi, db: PgUrls) -> None:
    _, v1 = first_published(api, db)
    assert_error(
        "discardDatasetVersion",
        api.delete("b.steward", f"/dataset-versions/{v1}"),
        409,
        "DATASET_VERSION_IMMUTABLE",
    )


def test_discard_needs_owner_steward(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, v1 = first_published(api, db)
    v2 = draft(api, dataset_id, "v2")["dataset_version_id"]
    assert_error(
        "discardDatasetVersion", api.delete("b.researcher", f"/dataset-versions/{v2}"), 404, "NOT_FOUND"
    )
    assert_error("discardDatasetVersion", api.delete("b.admin", f"/dataset-versions/{v2}"), 403, "FORBIDDEN")
    assert_error(
        "discardDatasetVersion", api.delete("a.steward", f"/dataset-versions/{v2}"), 404, "NOT_FOUND"
    )
    assert rows(db, "SELECT 1 FROM catalog.dataset_versions WHERE dataset_version_id = :v", v=v2) != []
