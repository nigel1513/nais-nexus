import base64
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import pytest

from api.modules.catalog.service import uploads
from api.modules.catalog.settings import CatalogSettings
from api.modules.catalog.testing import memory_store
from api.modules.catalog.tests.support import SHA_A, execute, insert_file, insert_version, rows
from api.modules.catalog.tests.support_api import CatalogApi, assert_error, create_dataset, new_draft
from api.modules.catalog.tests.support_upload import file_row, file_spec, sha, start_upload
from api.platform import clock
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls

KIB_CSV = b"a,b\n" + b"1,2\n" * 255
MIB = 1024 * 1024


def test_small_file_gets_a_presigned_put_on_the_gateway(
    api: CatalogApi, db: PgUrls
) -> None:  # M03-AT-05 (session)
    dataset_id, version_id = new_draft(api)
    now = datetime(2026, 10, 1, 9, 0, tzinfo=UTC)
    with clock.frozen(now):
        body = start_upload(api, version_id, {"data/a.csv": KIB_CSV})
    assert_matches_response("createUploadSession", 201, body)
    assert body["status"] == "OPEN" and body["expires_at"].startswith("2026-10-01T10:00:00")
    [item] = body["files"]
    assert item["status"] == "PENDING"
    upload = item["upload"]
    assert upload["method"] == "PUT"
    url = urlsplit(upload["url"])
    assert url.netloc == "localhost:21051"
    assert url.path == f"/nais-inst-b/datasets/{dataset_id}/{version_id}/data/a.csv"
    assert upload["headers"] == {
        "Content-Type": "text/csv",
        "x-amz-checksum-sha256": base64.b64encode(bytes.fromhex(sha(KIB_CSV))).decode(),
    }
    row = file_row(db, item["file_id"])
    assert (row["storage_bucket"], row["storage_key"]) == (
        "nais-inst-b",
        f"datasets/{dataset_id}/{version_id}/data/a.csv",
    )
    assert row["multipart_upload_id"] is None


def test_files_above_64_mib_use_multipart(api: CatalogApi, db: PgUrls) -> None:  # M03-AT-06 (session)
    _, version_id = new_draft(api)
    spec = {"path": "data/big.csv", "size_bytes": 100 * MIB, "sha256": SHA_A, "media_type": "text/csv"}
    response = api.post("b.steward", f"/dataset-versions/{version_id}/upload-session", json={"files": [spec]})
    assert response.status_code == 201, response.text
    assert_matches_response("createUploadSession", 201, response.json())
    upload = response.json()["files"][0]["upload"]
    assert upload["method"] == "MULTIPART" and upload["part_size_bytes"] == 64 * MIB
    assert [p["part_number"] for p in upload["parts"]] == [1, 2]
    row = file_row(db, response.json()["files"][0]["file_id"])
    assert row["multipart_upload_id"] in memory_store(api.deps.storage, "inst-b").uploads


@pytest.mark.parametrize(
    ("path", "media_type"),
    [
        ("tools/run.exe", "application/octet-stream"),
        ("data/a.csv", "application/json"),
        ("data/a.csv", "text/csv; charset=utf-8"),
    ],
)
def test_at08_disallowed_types_create_nothing(
    api: CatalogApi, db: PgUrls, path: str, media_type: str
) -> None:
    _, version_id = new_draft(api)
    spec = {"path": path, "size_bytes": 10, "sha256": SHA_A, "media_type": media_type}
    response = api.post(
        "b.steward",
        f"/dataset-versions/{version_id}/upload-session",
        json={"files": [file_spec("ok.csv", b"x"), spec]},
    )
    assert response.status_code == 422
    assert_matches_response("createUploadSession", 422, response.json())
    assert response.json()["error"]["code"] == "FILE_TYPE_NOT_ALLOWED"
    assert rows(db, "SELECT file_id FROM catalog.dataset_files") == []
    assert rows(db, "SELECT upload_session_id FROM catalog.upload_sessions") == []


def test_media_type_case_is_ignored(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    spec = {**file_spec("data/a.csv", KIB_CSV), "media_type": "Text/CSV"}
    response = api.post("b.steward", f"/dataset-versions/{version_id}/upload-session", json={"files": [spec]})
    assert response.status_code == 201
    assert file_row(db, response.json()["files"][0]["file_id"])["media_type"] == "text/csv"


@pytest.mark.parametrize("path", ["../etc/passwd", "a/../../b.csv", "./a.csv", "a//b.csv"])
def test_at10_path_traversal_is_validation_failed(api: CatalogApi, db: PgUrls, path: str) -> None:
    _, version_id = new_draft(api)
    spec = {"path": path, "size_bytes": 10, "sha256": SHA_A, "media_type": "text/csv"}
    response = api.post("b.steward", f"/dataset-versions/{version_id}/upload-session", json={"files": [spec]})
    assert response.status_code == 422
    assert_matches_response("createUploadSession", 422, response.json())
    error = response.json()["error"]
    assert error["code"] == "VALIDATION_FAILED"
    assert error["details"]["fields"][0]["field"] == "files.0.path"
    assert rows(db, "SELECT file_id FROM catalog.dataset_files") == []


def test_duplicate_paths_in_one_request_are_rejected(api: CatalogApi) -> None:
    _, version_id = new_draft(api)
    spec = file_spec("data/a.csv", KIB_CSV)
    response = api.post(
        "b.steward", f"/dataset-versions/{version_id}/upload-session", json={"files": [spec, spec]}
    )
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"] == [
        {"field": "files.1.path", "reason": "DUPLICATE_PATH"}
    ]


def test_files_above_50_gib_are_too_large(api: CatalogApi) -> None:
    _, version_id = new_draft(api)
    spec = {
        "path": "huge.parquet",
        "size_bytes": 50 * 1024**3 + 1,
        "sha256": SHA_A,
        "media_type": "application/vnd.apache.parquet",
    }
    response = api.post("b.steward", f"/dataset-versions/{version_id}/upload-session", json={"files": [spec]})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "FILE_TOO_LARGE"


def test_version_file_limit(api: CatalogApi, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(uploads, "MAX_FILES_PER_VERSION", 2)
    _, version_id = new_draft(api)
    start_upload(api, version_id, {"a.csv": b"1"})
    spec = [file_spec("b.csv", b"2"), file_spec("c.csv", b"3")]
    response = api.post("b.steward", f"/dataset-versions/{version_id}/upload-session", json={"files": spec})
    assert response.status_code == 422
    assert response.json()["error"]["details"]["fields"] == [{"field": "files", "reason": "TOO_MANY_FILES"}]


def test_existing_paths_conflict_but_failed_paths_are_reused(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    first = start_upload(api, version_id, {"data/a.csv": KIB_CSV})
    response = api.post(
        "b.steward",
        f"/dataset-versions/{version_id}/upload-session",
        json={"files": [file_spec("data/a.csv", KIB_CSV)]},
    )
    assert response.status_code == 409
    assert_matches_response("createUploadSession", 409, response.json())
    assert response.json()["error"]["details"]["paths"] == ["data/a.csv"]
    file_id = first["files"][0]["file_id"]
    execute(
        db,
        "UPDATE catalog.dataset_files SET status = 'FAILED', failure_code = 'CHECKSUM_MISMATCH' WHERE file_id = :id",
        id=file_id,
    )
    again = start_upload(api, version_id, {"data/a.csv": b"new,content\n"})
    assert again["files"][0]["file_id"] == file_id
    row = file_row(db, file_id)
    assert (row["status"], row["failure_code"], row["upload_session_id"]) == (
        "PENDING",
        None,
        UUID(again["upload_session_id"]),
    )
    assert row["sha256"] == sha(b"new,content\n")
    execute(db, "UPDATE catalog.dataset_files SET status = 'VERIFIED' WHERE file_id = :id", id=file_id)
    assert (
        api.post(
            "b.steward",
            f"/dataset-versions/{version_id}/upload-session",
            json={"files": [file_spec("data/a.csv", KIB_CSV)]},
        ).status_code
        == 409
    )


def test_pending_path_of_expired_session_is_reused(api: CatalogApi, db: PgUrls) -> None:  # Review Focus 1
    _, version_id = new_draft(api)
    first = start_upload(api, version_id, {"data/a.csv": KIB_CSV})
    with clock.frozen(datetime.now(UTC) + timedelta(hours=2)):
        again = start_upload(api, version_id, {"data/a.csv": KIB_CSV})
    assert again["files"][0]["file_id"] == first["files"][0]["file_id"]
    assert again["upload_session_id"] != first["upload_session_id"]


def test_at12_published_version_is_immutable(api: CatalogApi, db: PgUrls) -> None:  # M03-AT-12 (API part)
    dataset_id = create_dataset(api)["dataset_id"]
    version_id = insert_version(db, UUID(dataset_id), published=True, files=[("data/a.csv", 10, SHA_A)])
    response = api.post(
        "b.steward",
        f"/dataset-versions/{version_id}/upload-session",
        json={"files": [file_spec("b.csv", b"x")]},
    )
    assert response.status_code == 409
    assert_matches_response("createUploadSession", 409, response.json())
    assert response.json()["error"]["code"] == "DATASET_VERSION_IMMUTABLE"


def test_upload_session_permissions(api: CatalogApi) -> None:
    _, version_id = new_draft(api)
    body = {"files": [file_spec("a.csv", b"x")]}
    response = api.post("b.admin", f"/dataset-versions/{version_id}/upload-session", json=body)
    assert response.status_code == 403
    assert_matches_response("createUploadSession", 403, response.json())
    assert_error(
        "createUploadSession",
        api.post("a.steward", f"/dataset-versions/{version_id}/upload-session", json=body),
        404,
        "NOT_FOUND",
    )
    assert_error(
        "createUploadSession",
        api.post("b.steward", f"/dataset-versions/{uuid4()}/upload-session", json=body),
        404,
        "NOT_FOUND",
    )


def test_get_upload_session_renews_urls_only_while_open(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    created = start_upload(api, version_id, {"data/a.csv": KIB_CSV})
    response = api.get("b.steward", f"/upload-sessions/{created['upload_session_id']}")
    assert response.status_code == 200
    assert_matches_response("getUploadSession", 200, response.json())
    assert response.json()["files"][0]["upload"]["method"] == "PUT"
    execute(
        db,
        "UPDATE catalog.upload_sessions SET status = 'COMPLETED' WHERE upload_session_id = :id",
        id=created["upload_session_id"],
    )
    closed = api.get("b.steward", f"/upload-sessions/{created['upload_session_id']}").json()
    assert_matches_response("getUploadSession", 200, closed)
    assert "upload" not in closed["files"][0]


def test_get_upload_session_is_steward_only(api: CatalogApi) -> None:
    _, version_id = new_draft(api)
    created = start_upload(api, version_id, {"data/a.csv": KIB_CSV})
    for user in ("b.researcher", "a.steward"):
        response = api.get(user, f"/upload-sessions/{created['upload_session_id']}")
        assert response.status_code == 404
        assert_matches_response("getUploadSession", 404, response.json())


def test_storage_outage_is_dependency_unavailable(api: CatalogApi) -> None:
    _, version_id = new_draft(api)
    api.use(replace(api.deps, settings=CatalogSettings(storage_multipart_threshold_bytes=1)))
    store = memory_store(api.deps.storage, "inst-b")

    def broken(key: str, content_type: str) -> str:
        from api.modules.catalog.objects import StorageUnavailable

        raise StorageUnavailable("storage-b down")

    store.create_multipart = broken  # type: ignore[method-assign]
    response = api.post(
        "b.steward",
        f"/dataset-versions/{version_id}/upload-session",
        json={"files": [file_spec("a.csv", b"xy")]},
    )
    assert_error("createUploadSession", response, 503, "DEPENDENCY_UNAVAILABLE")
    assert "storage-b" not in response.text


def test_uploaded_path_conflicts(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    insert_file(db, UUID(version_id), path="data/z.csv", status="UPLOADED")
    response = api.post(
        "b.steward",
        f"/dataset-versions/{version_id}/upload-session",
        json={"files": [file_spec("data/z.csv", b"x")]},
    )
    assert response.status_code == 409
