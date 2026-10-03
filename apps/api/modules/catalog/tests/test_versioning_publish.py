"""Publish rules for lakeFS-style drafts (spec §3.3, §3.3b; Review Focus 2)."""

import threading
from typing import Any

import httpx

from api.modules.catalog.tests.support import execute, rows
from api.modules.catalog.tests.support_api import CatalogApi, assert_error, new_draft
from api.modules.catalog.tests.support_upload import start_upload, upload_files
from api.modules.catalog.tests.test_versioning_drafts import draft, first_published, publish
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


def _post_publish(api: CatalogApi, version_id: str) -> httpx.Response:
    return api.post("b.steward", f"/dataset-versions/{version_id}/publish")


def _note(api: CatalogApi, version_id: str, note: str = "a change") -> None:
    response = api.patch("b.steward", f"/dataset-versions/{version_id}", json={"change_note": note})
    assert response.status_code == 200, response.text


def test_change_note_required(api: CatalogApi, db: PgUrls) -> None:
    _, v1 = new_draft(api)
    upload_files(api, db, v1, {"data/a.csv": b"x\n1\n"})
    error = assert_error("publishDatasetVersion", _post_publish(api, v1), 409, "DATASET_VERSION_INCOMPLETE")
    assert error["details"]["reasons"] == ["CHANGE_NOTE_REQUIRED"]


def test_change_note_from_create_counts_but_must_have_three_characters(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, _ = first_published(api, db)
    short = draft(api, dataset_id, "v2-short", change_note="  ab  ")["dataset_version_id"]
    error = assert_error(
        "publishDatasetVersion", _post_publish(api, short), 409, "DATASET_VERSION_INCOMPLETE"
    )
    assert error["details"]["reasons"] == ["CHANGE_NOTE_REQUIRED"]
    ok = draft(api, dataset_id, "v2-ok", change_note="fixed units")["dataset_version_id"]
    assert _post_publish(api, ok).status_code == 200


def test_publish_sets_previous_version(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, v1 = first_published(api, db)
    v1_body = api.get("b.steward", f"/dataset-versions/{v1}").json()
    assert v1_body["previous_version_id"] is None  # the first published version has none
    v2 = draft(api, dataset_id, "v2")
    body = publish(api, v2["dataset_version_id"])
    assert_matches_response("publishDatasetVersion", 200, body)
    assert body["previous_version_id"] == v1 and body["base_version_id"] == v1
    assert body["base_is_latest"] is None  # no longer a draft
    revert = draft(api, dataset_id, "v3", from_version_id=v1)
    body = publish(api, revert["dataset_version_id"])
    assert body["previous_version_id"] == v2["dataset_version_id"] and body["source_version_id"] == v1


def test_stale_draft_is_rejected(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, v1 = first_published(api, db)
    a = draft(api, dataset_id, "v2-a")
    b = draft(api, dataset_id, "v2-b")
    publish(api, a["dataset_version_id"])
    _note(api, b["dataset_version_id"], "bbb")  # >= 3 characters, so the stale check is reached
    error = assert_error(
        "publishDatasetVersion",
        _post_publish(api, b["dataset_version_id"]),
        409,
        "DATASET_VERSION_STALE_BASE",
    )
    assert error["details"] == {"base_version_id": v1, "latest_version_id": a["dataset_version_id"]}
    body = api.get("b.steward", f"/dataset-versions/{b['dataset_version_id']}").json()
    assert body["base_is_latest"] is False and body["status"] == "DRAFT"


def test_null_base_is_stale_once_anything_is_published(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, a = new_draft(api)
    b = draft(api, dataset_id, "v1-b")["dataset_version_id"]
    assert api.get("b.steward", f"/dataset-versions/{b}").json()["base_version_id"] is None
    upload_files(api, db, a, {"data/a.csv": b"x\n1\n"})
    upload_files(api, db, b, {"data/b.csv": b"y\n2\n"})
    publish(api, a)
    _note(api, b)
    error = assert_error("publishDatasetVersion", _post_publish(api, b), 409, "DATASET_VERSION_STALE_BASE")
    assert error["details"] == {"base_version_id": None, "latest_version_id": a}


def test_checks_run_withdrawn_then_note_then_base_then_completeness(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, v1 = first_published(api, db)
    winner = draft(api, dataset_id, "v2-a")["dataset_version_id"]
    stale = draft(api, dataset_id, "v2-b", empty=True)["dataset_version_id"]  # no files: also incomplete
    publish(api, winner)
    # note before base
    error = assert_error(
        "publishDatasetVersion", _post_publish(api, stale), 409, "DATASET_VERSION_INCOMPLETE"
    )
    assert error["details"] == {"reasons": ["CHANGE_NOTE_REQUIRED"]}
    # base before completeness
    _note(api, stale)
    assert_error("publishDatasetVersion", _post_publish(api, stale), 409, "DATASET_VERSION_STALE_BASE")
    # completeness last: a current draft with a PENDING file
    current = draft(api, dataset_id, "v3")["dataset_version_id"]
    start_upload(api, current, {"data/new.csv": b"n\n1\n"})
    _note(api, current)
    error = assert_error(
        "publishDatasetVersion", _post_publish(api, current), 409, "DATASET_VERSION_INCOMPLETE"
    )
    assert [f["path"] for f in error["details"]["files"]] == ["data/new.csv"]
    # WITHDRAWN first of all
    no_note = draft(api, dataset_id, "v4")["dataset_version_id"]
    execute(db, "UPDATE catalog.datasets SET status = 'WITHDRAWN' WHERE dataset_id = :d", d=dataset_id)
    assert_error("publishDatasetVersion", _post_publish(api, no_note), 409, "CONFLICT")


def test_concurrent_publish_second_is_stale(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, _ = first_published(api, db)
    drafts = [draft(api, dataset_id, f"v2-{i}")["dataset_version_id"] for i in range(2)]
    for vid in drafts:
        _note(api, vid, "race")
    results: list[Any] = []
    errors: list[BaseException] = []
    barrier = threading.Barrier(2)

    def go(vid: str) -> None:
        try:
            barrier.wait(10)
            results.append(_post_publish(api, vid))
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=go, args=(vid,)) for vid in drafts]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    assert errors == []
    assert sorted(r.status_code for r in results) == [200, 409]
    winner = next(r for r in results if r.status_code == 200).json()
    loser = next(r for r in results if r.status_code == 409).json()
    assert loser["error"]["code"] == "DATASET_VERSION_STALE_BASE"
    assert loser["error"]["details"]["latest_version_id"] == winner["dataset_version_id"]


PROFILE = '{"format": "csv", "rows_sampled": 1, "total_rows": 1, "truncated": false, "columns_truncated": false, "columns": []}'


def test_inherited_files_reuse_finished_profiles(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, v1 = first_published(api, db)  # data/a.csv (tabular) + README.md
    # Make v1's preview READY as the Stage 1 job would.
    execute(
        db,
        "UPDATE catalog.file_previews SET status = 'READY', column_profile = CAST(:p AS jsonb),"
        " preview = CAST(:r AS jsonb), generated_at = now() WHERE dataset_version_id = :v",
        p=PROFILE,
        r='{"header": [], "rows": [], "rows_truncated": false, "columns": []}',
        v=v1,
    )
    v2 = draft(api, dataset_id, "v2")["dataset_version_id"]
    publish(api, v2)
    got = rows(
        db,
        "SELECT p.status, p.dataset_version_id, p.column_profile, f.path FROM catalog.file_previews p"
        " JOIN catalog.dataset_files f USING (file_id) WHERE f.dataset_version_id = :v",
        v=v2,
    )
    assert [(r["path"], r["status"], str(r["dataset_version_id"])) for r in got] == [
        ("data/a.csv", "READY", v2)
    ]
    assert got[0]["column_profile"]["total_rows"] == 1
    [file_id] = [
        f["file_id"]
        for f in api.get("b.steward", f"/dataset-versions/{v2}").json()["files"]
        if f["path"] == "data/a.csv"
    ]
    profile = api.get("b.steward", f"/dataset-files/{file_id}/profile").json()
    assert profile["status"] == "READY" and profile["total_rows"] == 1
    assert_matches_response("getFileProfile", 200, profile)


def test_pending_source_profile_is_queued_not_copied(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, v1 = first_published(api, db)  # v1's preview stays PENDING
    v2 = draft(api, dataset_id, "v2")["dataset_version_id"]
    upload_files(api, db, v2, {"data/new.csv": b"n\n1\n"})
    publish(api, v2)
    got = rows(
        db,
        "SELECT f.path, p.status, p.attempts, p.dataset_version_id FROM catalog.file_previews p"
        " JOIN catalog.dataset_files f USING (file_id) WHERE f.dataset_version_id = :v ORDER BY f.path",
        v=v2,
    )
    assert [(r["path"], r["status"], r["attempts"], str(r["dataset_version_id"])) for r in got] == [
        ("data/a.csv", "PENDING", 0, v2),
        ("data/new.csv", "PENDING", 0, v2),
    ]


def test_failed_source_profile_is_copied(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, v1 = first_published(api, db)
    execute(
        db,
        "UPDATE catalog.file_previews SET status = 'FAILED', failure_code = 'UNPARSEABLE', generated_at = now()"
        " WHERE dataset_version_id = :v",
        v=v1,
    )
    v2 = draft(api, dataset_id, "v2")["dataset_version_id"]
    publish(api, v2)
    [got] = rows(
        db, "SELECT status, failure_code FROM catalog.file_previews WHERE dataset_version_id = :v", v=v2
    )
    assert (got["status"], got["failure_code"]) == ("FAILED", "UNPARSEABLE")


def _plant_preview(db: PgUrls, version_id: str, path: str) -> Any:
    [row] = rows(
        db,
        "SELECT file_id FROM catalog.dataset_files WHERE dataset_version_id = :v AND path = :p",
        v=version_id,
        p=path,
    )
    execute(
        db,
        "INSERT INTO catalog.file_previews (file_id, dataset_version_id, status, column_profile, preview,"
        " generated_at) VALUES (:f, :v, 'READY', CAST(:p AS jsonb), CAST('{}' AS jsonb), now())",
        f=row["file_id"],
        v=version_id,
        p=PROFILE,
    )
    return row["file_id"]


def test_replacing_or_deleting_a_draft_row_drops_its_preview(api: CatalogApi, db: PgUrls) -> None:
    """Protocol (f): a row replaced in place (same file_id) or deleted loses its preview row first."""
    dataset_id, _ = first_published(api, db)
    v2 = draft(api, dataset_id, "v2")["dataset_version_id"]
    replaced = _plant_preview(db, v2, "data/a.csv")
    upload_files(api, db, v2, {"data/a.csv": b"x,y\n7,8\n"})
    assert rows(db, "SELECT 1 FROM catalog.file_previews WHERE file_id = :f", f=replaced) == []
    deleted = _plant_preview(db, v2, "README.md")
    assert api.delete("b.steward", f"/dataset-versions/{v2}/files/{deleted}").status_code == 204
    assert rows(db, "SELECT 1 FROM catalog.file_previews WHERE file_id = :f", f=deleted) == []
    # Publishing queues a fresh profile for the new object instead of inheriting a stale one.
    publish(api, v2)
    [row] = rows(db, "SELECT status FROM catalog.file_previews WHERE file_id = :f", f=replaced)
    assert row["status"] == "PENDING"
