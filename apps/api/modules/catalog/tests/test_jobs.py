from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import UUID

from dramatiq.brokers.stub import StubBroker

from api.modules.catalog import MODULE
from api.modules.catalog.jobs import expire_upload_sessions, register_worker, requeue_stale_uploads
from api.modules.catalog.settings import CatalogSettings
from api.modules.catalog.testing import RecordingVerificationQueue, memory_store
from api.modules.catalog.tests.support import execute, rows
from api.modules.catalog.tests.support_api import CatalogApi, new_draft
from api.modules.catalog.tests.support_upload import file_row, start_upload
from api.platform import clock
from api.platform.scheduler import Scheduler
from api.platform.settings import Settings
from api.platform.testing.fixtures import PgUrls
from api.worker import build_worker

CSV = b"a,b\n" + b"1,2\n" * 400


def test_at22_expired_session_fails_pending_files_and_aborts_multipart(api: CatalogApi, db: PgUrls) -> None:
    api.use(
        replace(
            api.deps,
            settings=CatalogSettings(
                storage_multipart_threshold_bytes=1024, catalog_multipart_part_size_bytes=1024
            ),
        )
    )
    _, version_id = new_draft(api)
    started = datetime.now(UTC)
    with clock.frozen(started):
        body = start_upload(api, version_id, {"big.csv": CSV, "small.csv": b"a\n"})
    by_path = {f["path"]: f for f in body["files"]}
    big, small = file_row(db, by_path["big.csv"]["file_id"]), file_row(db, by_path["small.csv"]["file_id"])
    store = memory_store(api.deps.storage, "inst-b")
    store.put(small["storage_key"], b"a\n", "text/csv")  # uploaded but never completed
    with clock.frozen(started + timedelta(minutes=30)):
        assert expire_upload_sessions(api.deps) == 0
    with clock.frozen(started + timedelta(minutes=61)):
        assert expire_upload_sessions(api.deps) == 1
        assert expire_upload_sessions(api.deps) == 0
    assert rows(db, "SELECT status FROM catalog.upload_sessions") == [{"status": "EXPIRED"}]
    for row in (big, small):
        after = file_row(db, row["file_id"])
        assert (after["status"], after["failure_code"]) == ("FAILED", "SESSION_EXPIRED")
    assert store.aborted == [big["multipart_upload_id"]]
    assert store.head(small["storage_key"]) is None
    again = start_upload(api, version_id, {"small.csv": b"a\n"})
    assert again["files"][0]["file_id"] == str(small["file_id"])


def test_verified_files_are_left_alone(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": b"a\n"})
    execute(db, "UPDATE catalog.dataset_files SET status = 'UPLOADED'")
    with clock.frozen(datetime.now(UTC) + timedelta(hours=2)):
        assert expire_upload_sessions(api.deps) == 1
    assert file_row(db, body["files"][0]["file_id"])["status"] == "UPLOADED"


def test_stale_uploaded_files_are_requeued_once(api: CatalogApi, db: PgUrls) -> None:
    queue = RecordingVerificationQueue()
    api.use(replace(api.deps, verification=queue))
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": b"a\n"})
    file_id = UUID(body["files"][0]["file_id"])
    execute(
        db, "UPDATE catalog.dataset_files SET status = 'UPLOADED', updated_at = now() - interval '3 hours'"
    )
    assert requeue_stale_uploads(api.deps) == 1
    assert queue.enqueued == [file_id]
    assert requeue_stale_uploads(api.deps) == 0


def test_register_worker_schedules_the_catalog_jobs() -> None:
    scheduler = Scheduler()
    register_worker(StubBroker(), scheduler)
    assert scheduler.job_names == ["catalog.index_drain", "catalog.expire_upload_sessions"]


def test_worker_boots_with_the_catalog_module() -> None:
    runtime = build_worker(modules=[MODULE], broker=StubBroker(), settings=Settings())
    assert "catalog.index_drain" in runtime.scheduler.job_names
