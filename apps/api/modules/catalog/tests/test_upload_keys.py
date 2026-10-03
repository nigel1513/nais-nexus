"""D-039: per-session storage keys, URL TTL capped by the session, deletion only after commit."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from api.modules.catalog.settings import CatalogSettings
from api.modules.catalog.testing import memory_store
from api.modules.catalog.tests.support import execute
from api.modules.catalog.tests.support_api import CatalogApi, new_draft, publish_draft
from api.modules.catalog.tests.support_upload import (
    complete,
    file_row,
    put_uploaded,
    sha,
    start_upload,
    upload_files,
)
from api.platform import clock
from api.platform.testing.fixtures import PgUrls

GOOD = b"x,y\n1,2\n"
EVIL = b"x,y\n9,9\n"


def test_key_contains_the_upload_session_id(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, version_id = new_draft(api)
    body = start_upload(api, version_id, {"data/a.csv": GOOD})
    key = file_row(db, body["files"][0]["file_id"])["storage_key"]
    assert key == f"datasets/{dataset_id}/{version_id}/{body['upload_session_id']}/data/a.csv"


def test_stale_presigned_put_cannot_overwrite_a_published_object(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    store = memory_store(api.deps.storage, "inst-b")
    first = start_upload(api, version_id, {"p.csv": EVIL})
    first_key = file_row(db, first["files"][0]["file_id"])["storage_key"]
    put_uploaded(api, db, first, {"p.csv": GOOD})  # wrong content: fails verification
    assert complete(api, first["upload_session_id"]).json()["files"][0]["status"] == "FAILED"
    second = upload_files(api, db, version_id, {"p.csv": GOOD})
    assert second["files"][0]["status"] == "VERIFIED"
    assert publish_draft(api, version_id).status_code == 200
    row = file_row(db, second["files"][0]["file_id"])
    assert row["storage_key"] != first_key
    store.put(first_key, EVIL, "text/csv")  # the first session's presigned URL is still live
    assert sha(store.read_range(row["storage_key"], 0, len(GOOD) - 1)) == sha(GOOD)


def test_reused_row_gets_the_new_key_and_old_object_is_removed_after_commit(
    api: CatalogApi, db: PgUrls, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, version_id = new_draft(api)
    store = memory_store(api.deps.storage, "inst-b")
    first = start_upload(api, version_id, {"p.csv": GOOD})
    old = file_row(db, first["files"][0]["file_id"])
    store.put(old["storage_key"], EVIL, "text/csv")
    execute(db, "UPDATE catalog.dataset_files SET status = 'FAILED' WHERE file_id = :i", i=old["file_id"])
    seen: list[str] = []
    real_delete = store.delete

    def spy(key: str) -> None:
        seen.append(file_row(db, old["file_id"])["storage_key"])  # visible only once the tx committed
        real_delete(key)

    monkeypatch.setattr(store, "delete", spy)
    second = start_upload(api, version_id, {"p.csv": GOOD})
    new = file_row(db, second["files"][0]["file_id"])
    assert new["storage_key"] != old["storage_key"]
    assert seen == [new["storage_key"]]
    assert store.head(old["storage_key"]) is None


def test_upload_urls_never_outlive_the_session(api: CatalogApi, db: PgUrls) -> None:
    api.use(
        replace(
            api.deps,
            settings=CatalogSettings(upload_url_ttl_seconds=3600, upload_session_ttl_seconds=1800),
        )
    )
    _, version_id = new_draft(api)
    t0 = datetime(2026, 10, 1, 9, 0, tzinfo=UTC)
    with clock.frozen(t0):
        body = start_upload(api, version_id, {"a.csv": GOOD})
    assert "X-Amz-Expires=1800&" in body["files"][0]["upload"]["url"]
    path = f"/upload-sessions/{body['upload_session_id']}"
    with clock.frozen(t0 + timedelta(seconds=600)):
        assert "X-Amz-Expires=1200&" in api.get("b.steward", path).json()["files"][0]["upload"]["url"]
    with clock.frozen(t0 + timedelta(seconds=1800)):
        late = api.get("b.steward", path).json()
    assert "upload" not in late["files"][0]


def test_multipart_part_urls_are_capped_too(api: CatalogApi, db: PgUrls) -> None:
    api.use(
        replace(
            api.deps,
            settings=CatalogSettings(
                upload_url_ttl_seconds=3600,
                upload_session_ttl_seconds=900,
                storage_multipart_threshold_bytes=4,
                catalog_multipart_part_size_bytes=4,
            ),
        )
    )
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": GOOD})
    assert all(
        "X-Amz-Expires=900&" in p["url"] or "X-Amz-Expires=899&" in p["url"]
        for p in body["files"][0]["upload"]["parts"]
    )


def test_open_session_past_expiry_reads_as_expired(api: CatalogApi) -> None:
    _, version_id = new_draft(api)
    body = start_upload(api, version_id, {"a.csv": GOOD})
    with clock.frozen(datetime.now(UTC) + timedelta(hours=2)):
        polled = api.get("b.steward", f"/upload-sessions/{body['upload_session_id']}").json()
    assert polled["status"] == "EXPIRED"


def test_delete_removes_the_object_only_after_commit(
    api: CatalogApi, db: PgUrls, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, version_id = new_draft(api)
    store = memory_store(api.deps.storage, "inst-b")
    body = start_upload(api, version_id, {"a.csv": GOOD})
    put_uploaded(api, db, body, {"a.csv": EVIL})
    complete(api, body["upload_session_id"])  # fails verification, row FAILED
    row = file_row(db, body["files"][0]["file_id"])
    store.put(row["storage_key"], EVIL, "text/csv")
    seen: list[bool] = []
    real_delete = store.delete

    def spy(key: str) -> None:
        from api.modules.catalog.tests.support import rows

        seen.append(
            rows(db, "SELECT 1 FROM catalog.dataset_files WHERE file_id = :i", i=row["file_id"]) == []
        )
        real_delete(key)

    monkeypatch.setattr(store, "delete", spy)
    assert (
        api.delete("b.steward", f"/dataset-versions/{version_id}/files/{row['file_id']}").status_code == 204
    )
    assert seen == [True]
    assert store.head(row["storage_key"]) is None


def test_rejected_delete_keeps_the_object(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    store = memory_store(api.deps.storage, "inst-b")
    body = start_upload(api, version_id, {"a.csv": GOOD})
    row = file_row(db, body["files"][0]["file_id"])
    store.put(row["storage_key"], GOOD, "text/csv")
    response = api.delete("b.steward", f"/dataset-versions/{version_id}/files/{row['file_id']}")
    assert response.status_code == 409
    assert store.head(row["storage_key"]) == len(GOOD)
