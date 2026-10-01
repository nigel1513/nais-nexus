"""Failure handling around completion/verification: nothing stays stuck, nothing leaks, 503s are generic."""

from dataclasses import replace
from typing import Any
from uuid import UUID

import pytest

from api.modules.catalog.jobs import verify_file_job
from api.modules.catalog.objects import StorageUnavailable
from api.modules.catalog.settings import CatalogSettings
from api.modules.catalog.testing import RecordingVerificationQueue, memory_store
from api.modules.catalog.tests.support import execute, rows
from api.modules.catalog.tests.support_api import CatalogApi, new_draft
from api.modules.catalog.tests.support_upload import complete, file_row, put_uploaded, start_upload
from api.platform.testing.fixtures import PgUrls

CSV = b"sample_id,value\n" + b"S0001,1.0\n" * 300


class FlakyScanner:
    def __init__(self, error: Exception | None) -> None:
        self.error = error

    def scan(self, bucket: str, key: str) -> Any:
        if self.error is not None:
            raise self.error
        return type("R", (), {"status": "CLEAN"})()


def test_scanner_failure_in_sync_path_leaves_file_for_the_worker(api: CatalogApi, db: PgUrls) -> None:
    scanner = FlakyScanner(RuntimeError("scanner down"))
    api.use(replace(api.deps, scanner=scanner))  # type: ignore[arg-type]
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": CSV})
    put_uploaded(api, db, body, {"a.csv": CSV})
    response = complete(api, body["upload_session_id"])
    assert response.status_code == 200, response.text
    file_id = UUID(response.json()["files"][0]["file_id"])
    assert response.json()["files"][0]["status"] == "UPLOADED"
    queue = api.deps.verification
    assert isinstance(queue, RecordingVerificationQueue) and queue.enqueued == [file_id]
    scanner.error = None
    assert verify_file_job(file_id, deps=api.deps) == "VERIFIED"


def test_job_storage_or_scanner_error_leaves_row_uploaded(api: CatalogApi, db: PgUrls) -> None:
    api.use(replace(api.deps, settings=CatalogSettings(catalog_sync_verify_max_bytes=10)))
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": CSV})
    put_uploaded(api, db, body, {"a.csv": CSV})
    file_id = UUID(complete(api, body["upload_session_id"]).json()["files"][0]["file_id"])
    scanner = FlakyScanner(StorageUnavailable("boom"))
    api.use(replace(api.deps, scanner=scanner))  # type: ignore[arg-type]
    with pytest.raises(StorageUnavailable):
        verify_file_job(file_id, deps=api.deps)
    scanner.error = RuntimeError("scanner crashed")
    with pytest.raises(RuntimeError):
        verify_file_job(file_id, deps=api.deps)
    assert file_row(db, file_id)["status"] == "UPLOADED"
    scanner.error = None
    assert verify_file_job(file_id, deps=api.deps) == "VERIFIED"


def test_storage_outage_on_complete_is_503_without_details(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": CSV})
    put_uploaded(api, db, body, {"a.csv": CSV})
    store = memory_store(api.deps.storage, "inst-b")

    def broken(key: str) -> int | None:
        raise StorageUnavailable("secret-internal-host:9000 refused")

    store.head = broken  # type: ignore[method-assign]
    response = complete(api, body["upload_session_id"])
    assert response.status_code == 503
    assert "secret-internal-host" not in response.text
    assert rows(db, "SELECT status FROM catalog.upload_sessions") == [{"status": "OPEN"}]


def test_deleting_a_failed_multipart_file_aborts_its_upload(api: CatalogApi, db: PgUrls) -> None:
    settings = CatalogSettings(storage_multipart_threshold_bytes=1024, catalog_multipart_part_size_bytes=1024)
    api.use(replace(api.deps, settings=settings))
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"big.csv": CSV})
    file_id = body["files"][0]["file_id"]
    upload_id = file_row(db, file_id)["multipart_upload_id"]
    execute(db, "UPDATE catalog.upload_sessions SET status = 'COMPLETED'")
    execute(db, "UPDATE catalog.dataset_files SET status = 'FAILED', failure_code = 'OBJECT_MISSING'")
    response = api.delete("b.steward", f"/dataset-versions/{version_id}/files/{file_id}")
    assert response.status_code == 204
    assert upload_id in memory_store(api.deps.storage, "inst-b").aborted
