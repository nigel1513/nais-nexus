import hashlib
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from dramatiq.brokers.stub import StubBroker

from api.modules.catalog.adapters.queue import DramatiqVerificationQueue
from api.modules.catalog.jobs import verify_file_actor, verify_file_job
from api.modules.catalog.settings import CatalogSettings
from api.modules.catalog.testing import RecordingVerificationQueue, memory_store
from api.modules.catalog.tests.support import SHA_A, insert_version, rows
from api.modules.catalog.tests.support_api import CatalogApi, assert_error, create_dataset, new_draft
from api.modules.catalog.tests.support_upload import (
    complete,
    file_row,
    file_spec,
    put_uploaded,
    start_upload,
    upload_files,
)
from api.platform import clock
from api.platform.broker import configure_broker
from api.platform.settings import Settings
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls

CSV = b"sample_id,value\n" + b"S0001,1.0\n" * 300  # 3016 bytes: 3 parts under SMALL_MULTIPART
SMALL_MULTIPART = CatalogSettings(
    storage_multipart_threshold_bytes=1024, catalog_multipart_part_size_bytes=1024
)


def test_small_session_is_verified_synchronously(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    result = upload_files(api, db, version_id, {"data/a.csv": CSV})
    assert_matches_response("completeUploadSession", 200, result)
    assert result["status"] == "COMPLETED"
    assert [(f["status"], f["failure_code"]) for f in result["files"]] == [("VERIFIED", None)]
    row = file_row(db, result["files"][0]["file_id"])
    assert row["verified_at"] is not None and row["scan_status"] == "SKIPPED"
    assert api.deps.verification.enqueued == []  # type: ignore[attr-defined]


def test_missing_object_and_size_mismatch_fail(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": CSV, "b.csv": CSV})
    store = memory_store(api.deps.storage, "inst-b")
    b_key = file_row(db, body["files"][1]["file_id"])["storage_key"]
    store.put(b_key, CSV + b"extra", "text/csv")
    result = complete(api, body["upload_session_id"]).json()
    assert {f["path"]: (f["status"], f["failure_code"]) for f in result["files"]} == {
        "a.csv": ("FAILED", "OBJECT_MISSING"),
        "b.csv": ("FAILED", "SIZE_MISMATCH"),
    }
    assert store.head(b_key) is None


def test_checksum_mismatch_deletes_the_object(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": CSV})
    tampered = CSV.replace(b"1.0", b"9.9")
    put_uploaded(api, db, body, {"a.csv": tampered})
    result = complete(api, body["upload_session_id"]).json()
    assert (result["files"][0]["status"], result["files"][0]["failure_code"]) == (
        "FAILED",
        "CHECKSUM_MISMATCH",
    )
    assert (
        memory_store(api.deps.storage, "inst-b").head(
            file_row(db, body["files"][0]["file_id"])["storage_key"]
        )
        is None
    )


def test_multipart_upload_completes_and_verifies(api: CatalogApi, db: PgUrls) -> None:
    api.use(replace(api.deps, settings=SMALL_MULTIPART))
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"data/big.csv": CSV})
    assert body["files"][0]["upload"]["method"] == "MULTIPART"
    parts = put_uploaded(api, db, body, {"data/big.csv": CSV})
    response = complete(api, body["upload_session_id"], parts)
    assert response.status_code == 200, response.text
    assert response.json()["files"][0]["status"] == "VERIFIED"


def test_at07_multipart_with_wrong_content_fails_and_is_deleted(
    api: CatalogApi, db: PgUrls
) -> None:  # memory variant
    api.use(replace(api.deps, settings=SMALL_MULTIPART))
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"data/big.csv": CSV})
    parts = put_uploaded(api, db, body, {"data/big.csv": CSV.replace(b"S0001", b"S0002")})
    result = complete(api, body["upload_session_id"], parts).json()
    assert (result["files"][0]["status"], result["files"][0]["failure_code"]) == (
        "FAILED",
        "CHECKSUM_MISMATCH",
    )
    key = file_row(db, body["files"][0]["file_id"])["storage_key"]
    assert memory_store(api.deps.storage, "inst-b").head(key) is None


def test_multipart_needs_its_parts(api: CatalogApi, db: PgUrls) -> None:
    api.use(replace(api.deps, settings=SMALL_MULTIPART))
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"data/big.csv": CSV})
    response = complete(api, body["upload_session_id"], {"parts": []})
    assert response.status_code == 422
    assert_matches_response("completeUploadSession", 422, response.json())
    assert response.json()["error"]["details"]["fields"][0]["reason"] == "MISSING_PARTS"
    unknown = complete(
        api,
        body["upload_session_id"],
        {"parts": [{"file_id": str(uuid4()), "etags": [{"part_number": 1, "etag": "x"}]}]},
    )
    assert unknown.status_code == 422
    assert rows(db, "SELECT status FROM catalog.upload_sessions") == [{"status": "OPEN"}]


def test_bad_etag_fails_the_file_as_object_missing(api: CatalogApi, db: PgUrls) -> None:
    api.use(replace(api.deps, settings=SMALL_MULTIPART))
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"data/big.csv": CSV})
    parts = put_uploaded(api, db, body, {"data/big.csv": CSV})
    parts["parts"][0]["etags"][0]["etag"] = '"deadbeef"'
    result = complete(api, body["upload_session_id"], parts).json()
    assert (result["files"][0]["status"], result["files"][0]["failure_code"]) == ("FAILED", "OBJECT_MISSING")


def test_second_complete_is_conflict(api: CatalogApi, db: PgUrls) -> None:  # Review Focus 4
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": CSV})
    put_uploaded(api, db, body, {"a.csv": CSV})
    assert complete(api, body["upload_session_id"]).status_code == 200
    response = complete(api, body["upload_session_id"])
    assert response.status_code == 409
    assert_matches_response("completeUploadSession", 409, response.json())
    assert response.json()["error"]["code"] == "CONFLICT"
    assert file_row(db, body["files"][0]["file_id"])["status"] == "VERIFIED"


def test_expired_session_cannot_be_completed(api: CatalogApi) -> None:
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": CSV})
    with clock.frozen(datetime.now(UTC) + timedelta(hours=2)):
        response = complete(api, body["upload_session_id"])
    assert response.status_code == 409
    assert_matches_response("completeUploadSession", 409, response.json())
    assert response.json()["error"]["code"] == "UPLOAD_SESSION_EXPIRED"


def test_only_creator_or_owner_steward_can_complete(api: CatalogApi) -> None:
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": CSV})
    assert_error(
        "completeUploadSession", complete(api, body["upload_session_id"], user="b.admin"), 403, "FORBIDDEN"
    )
    assert_error(
        "completeUploadSession", complete(api, body["upload_session_id"], user="a.steward"), 404, "NOT_FOUND"
    )
    assert_error("completeUploadSession", complete(api, str(uuid4())), 404, "NOT_FOUND")


def test_large_sessions_are_verified_by_the_worker(api: CatalogApi, db: PgUrls) -> None:
    api.use(replace(api.deps, settings=CatalogSettings(catalog_sync_verify_max_bytes=10)))
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": CSV})
    put_uploaded(api, db, body, {"a.csv": CSV})
    result = complete(api, body["upload_session_id"]).json()
    file_id = UUID(result["files"][0]["file_id"])
    assert result["files"][0]["status"] == "UPLOADED"
    queue = api.deps.verification
    assert isinstance(queue, RecordingVerificationQueue) and queue.enqueued == [file_id]
    assert verify_file_job(file_id, deps=api.deps) == "VERIFIED"
    assert verify_file_job(file_id, deps=api.deps) is None  # at-least-once delivery: second run is a no-op
    polled = api.get("b.steward", f"/upload-sessions/{body['upload_session_id']}").json()
    assert polled["files"][0]["status"] == "VERIFIED"


def test_dramatiq_queue_sends_one_message_per_file() -> None:
    broker = configure_broker(Settings(), StubBroker())
    DramatiqVerificationQueue().enqueue([uuid4(), uuid4()])
    assert broker.queues["catalog"].qsize() == 2  # type: ignore[attr-defined]
    assert verify_file_actor.actor_name == "catalog.verify_file"


def test_delete_draft_file(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": CSV})
    tampered = {"a.csv": CSV.replace(b"1.0", b"2.0")}
    put_uploaded(api, db, body, tampered)
    complete(api, body["upload_session_id"])
    file_id = body["files"][0]["file_id"]
    response = api.delete("b.steward", f"/dataset-versions/{version_id}/files/{file_id}")
    assert response.status_code == 204 and response.content == b""
    assert rows(db, "SELECT file_id FROM catalog.dataset_files") == []
    again = api.delete("b.steward", f"/dataset-versions/{version_id}/files/{file_id}")
    assert again.status_code == 404
    assert_matches_response("deleteDraftFile", 404, again.json())


def test_delete_rules(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": CSV})
    file_id = body["files"][0]["file_id"]
    pending = api.delete("b.steward", f"/dataset-versions/{version_id}/files/{file_id}")
    assert pending.status_code == 409
    assert_matches_response("deleteDraftFile", 409, pending.json())
    forbidden = api.delete("b.researcher", f"/dataset-versions/{version_id}/files/{file_id}")
    assert forbidden.status_code == 404  # draft versions are invisible to non-stewards
    dataset_id = create_dataset(api)["dataset_id"]
    published = insert_version(db, UUID(dataset_id), published=True, files=[("data/a.csv", 10, SHA_A)])
    published_file = rows(
        db, "SELECT file_id FROM catalog.dataset_files WHERE dataset_version_id = :v", v=published
    )[0]["file_id"]
    immutable = api.delete("b.steward", f"/dataset-versions/{published}/files/{published_file}")
    assert immutable.status_code == 409
    assert immutable.json()["error"]["code"] == "DATASET_VERSION_IMMUTABLE"


def test_upload_session_body_after_complete_has_no_urls(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    result = upload_files(api, db, version_id, {"a.csv": CSV, "b.json": b'{"k": 1}'})
    assert all("upload" not in f for f in result["files"])
    assert hashlib.sha256(CSV).hexdigest() == file_spec("a.csv", CSV)["sha256"]
