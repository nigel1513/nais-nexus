import threading
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from dramatiq.brokers.stub import StubBroker
from sqlalchemy import text

from api.modules.catalog import MODULE, jobs
from api.modules.catalog.jobs import (
    expire_upload_sessions,
    register_worker,
    requeue_stale_uploads,
    verify_file_job,
)
from api.modules.catalog.settings import CatalogSettings
from api.modules.catalog.testing import RecordingVerificationQueue, memory_store
from api.modules.catalog.tests.support import execute, rows
from api.modules.catalog.tests.support_api import CatalogApi, new_draft
from api.modules.catalog.tests.support_upload import file_row, start_upload
from api.platform import clock
from api.platform.db import session_factory
from api.platform.ids import new_id
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
    assert scheduler.job_names == [
        "catalog.index_drain",
        "catalog.expire_upload_sessions",
        "catalog.preview_dispatch",
    ]
    assert [job.interval_s for job in scheduler._jobs] == [2.0, 300.0, 10.0]


def test_worker_boots_with_the_catalog_module() -> None:
    runtime = build_worker(modules=[MODULE], broker=StubBroker(), settings=Settings())
    assert "catalog.index_drain" in runtime.scheduler.job_names


def test_sweep_skips_a_version_locked_by_a_writer_then_expires_it(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    started = datetime.now(UTC)
    with clock.frozen(started):
        start_upload(api, version_id, {"a.csv": b"a\n"})
    with clock.frozen(started + timedelta(minutes=61)):
        with session_factory(db.app)() as other, other.begin():
            other.execute(
                text("SELECT 1 FROM catalog.dataset_versions WHERE dataset_version_id = :v FOR UPDATE"),
                {"v": version_id},
            )
            assert expire_upload_sessions(api.deps) == 0
            assert rows(db, "SELECT status FROM catalog.upload_sessions") == [{"status": "OPEN"}]
        assert expire_upload_sessions(api.deps) == 1
    assert rows(db, "SELECT status FROM catalog.upload_sessions") == [{"status": "EXPIRED"}]


def test_storage_failure_during_cleanup_does_not_block_the_db_update(api: CatalogApi, db: PgUrls) -> None:
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
    store = memory_store(api.deps.storage, "inst-b")

    def boom(*_: object) -> None:
        raise RuntimeError("storage down")

    store.abort_multipart = boom  # type: ignore[method-assign]
    store.delete = boom  # type: ignore[method-assign]
    with clock.frozen(started + timedelta(minutes=61)):
        assert expire_upload_sessions(api.deps) == 1
    assert rows(db, "SELECT status FROM catalog.upload_sessions") == [{"status": "EXPIRED"}]
    for f in body["files"]:
        after = file_row(db, f["file_id"])
        assert (after["status"], after["failure_code"]) == ("FAILED", "SESSION_EXPIRED")


def test_fresh_uploaded_files_are_not_requeued(api: CatalogApi, db: PgUrls) -> None:
    queue = RecordingVerificationQueue()
    api.use(replace(api.deps, verification=queue))
    _, version_id = new_draft(api)
    start_upload(api, version_id, {"a.csv": b"a\n"})
    execute(
        db, "UPDATE catalog.dataset_files SET status = 'UPLOADED', updated_at = now() - interval '10 minutes'"
    )
    assert requeue_stale_uploads(api.deps) == 0
    assert queue.enqueued == []


def _uploaded_file(api: CatalogApi, db: PgUrls, data: bytes = b"a\n") -> tuple[str, UUID, UUID]:
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": data})
    file_id = UUID(body["files"][0]["file_id"])
    row = file_row(db, file_id)
    memory_store(api.deps.storage, "inst-b").put(row["storage_key"], data, "text/csv")
    execute(db, "UPDATE catalog.dataset_files SET status = 'UPLOADED'")
    return version_id, file_id, UUID(body["upload_session_id"])


def test_duplicate_verify_message_cannot_fail_a_reused_upload(api: CatalogApi, db: PgUrls) -> None:  # ABA
    version_id, file_id, _ = _uploaded_file(api, db, b"wrong\n")  # the declared sha is of the same bytes
    execute(
        db, "UPDATE catalog.dataset_files SET sha256 = :s", s="b" * 64
    )  # -> CHECKSUM_MISMATCH when verified
    new_session = new_id()

    def reuse_row() -> None:  # the row is re-used by a newer upload while the old verify run is in flight
        execute(
            db,
            "INSERT INTO catalog.upload_sessions (upload_session_id, dataset_version_id, status, created_by,"
            " expires_at) VALUES (:s, :v, 'OPEN', :v, now() + interval '1 hour')",
            s=new_session,
            v=version_id,
        )
        execute(
            db,
            "UPDATE catalog.dataset_files SET upload_session_id = :s, status = 'UPLOADED', failure_code = NULL",
            s=new_session,
        )

    real_evaluate = jobs.evaluate_object

    def evaluate_then_reuse(*args: Any, **kwargs: Any) -> Any:
        outcome = real_evaluate(*args, **kwargs)
        reuse_row()
        return outcome

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(jobs, "evaluate_object", evaluate_then_reuse)
        assert verify_file_job(file_id, deps=api.deps) is None
    assert file_row(db, file_id)["status"] == "UPLOADED"


def test_verify_apply_takes_the_version_lock_before_the_file_row(api: CatalogApi, db: PgUrls) -> None:
    version_id, file_id, _ = _uploaded_file(api, db)
    result: list[str | None] = []
    with session_factory(db.app)() as other, other.begin():
        other.execute(
            text("SELECT 1 FROM catalog.dataset_versions WHERE dataset_version_id = :v FOR UPDATE"),
            {"v": version_id},
        )
        worker = threading.Thread(target=lambda: result.append(verify_file_job(file_id, deps=api.deps)))
        worker.start()
        worker.join(1.0)
        assert worker.is_alive()  # waits for the version lock ...
        other.execute(  # ... without holding the file row (global order: version -> session -> file)
            text("SELECT 1 FROM catalog.dataset_files WHERE file_id = :f FOR UPDATE NOWAIT"), {"f": file_id}
        )
    worker.join(10)
    assert result == ["VERIFIED"]


def test_requeue_skips_files_of_a_version_locked_by_a_writer(api: CatalogApi, db: PgUrls) -> None:
    queue = RecordingVerificationQueue()
    api.use(replace(api.deps, verification=queue))
    version_id, file_id, _ = _uploaded_file(api, db)
    execute(db, "UPDATE catalog.dataset_files SET updated_at = now() - interval '3 hours'")
    with session_factory(db.app)() as other, other.begin():
        other.execute(
            text("SELECT 1 FROM catalog.dataset_versions WHERE dataset_version_id = :v FOR UPDATE"),
            {"v": version_id},
        )
        assert requeue_stale_uploads(api.deps) == 0
    assert requeue_stale_uploads(api.deps) == 1
    assert queue.enqueued == [file_id]
