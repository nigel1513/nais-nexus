"""Shared stored objects are deleted only when nothing references them (spec §3.3b, Review Focus 1).

Drafts that inherit rows are built in SQL here (Ruling S5): the create-draft API arrives in Task 4."""

import threading
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import text

from api.modules.catalog.testing import memory_store
from api.modules.catalog.tests.support import execute, insert_dataset, insert_version, rows
from api.modules.catalog.tests.support_api import CatalogApi, new_draft
from api.modules.catalog.tests.support_upload import complete, put_uploaded, start_upload, upload_files
from api.modules.catalog.versioning.refs import InheritanceViolation, release_objects, require_inheritable
from api.platform.db import session_factory
from api.platform.ids import new_id
from api.platform.testing.fixtures import PgUrls

DATA = {"data/a.csv": b"x,y\n1,2\n"}


def _inherit(db: PgUrls, to_version: str | UUID, src_file_id: UUID) -> UUID:
    file_id = new_id()
    execute(
        db,
        "INSERT INTO catalog.dataset_files (file_id, dataset_version_id, upload_session_id, inherited_from_file_id,"
        " path, size_bytes, sha256, media_type, storage_bucket, storage_key, status, scan_status, verified_at)"
        " SELECT :id, :v2, NULL, file_id, path, size_bytes, sha256, media_type, storage_bucket, storage_key,"
        " 'VERIFIED', scan_status, verified_at FROM catalog.dataset_files WHERE file_id = :src",
        id=file_id,
        v2=to_version,
        src=src_file_id,
    )
    return file_id


def _published_with_draft_inheriting(api: CatalogApi, db: PgUrls) -> tuple[str, UUID, dict[str, Any]]:
    dataset_id, v1 = new_draft(api)
    upload_files(api, db, v1, DATA)
    assert api.post("b.steward", f"/dataset-versions/{v1}/publish").status_code == 200
    v2 = insert_version(db, UUID(dataset_id), label="v2")  # DRAFT (Ruling S5: SQL, not the Task 4 API)
    [src] = rows(db, "SELECT * FROM catalog.dataset_files WHERE dataset_version_id = :v", v=v1)
    _inherit(db, v2, src["file_id"])
    return v1, v2, src


def _objects(api: CatalogApi) -> dict[str, bytes]:
    objects: dict[str, bytes] = memory_store(api.deps.storage, "inst-b").objects
    return objects


def test_deleting_inherited_file_keeps_published_object(api: CatalogApi, db: PgUrls) -> None:
    v1, v2, src = _published_with_draft_inheriting(api, db)
    [inherited] = rows(db, "SELECT file_id FROM catalog.dataset_files WHERE dataset_version_id = :v", v=v2)
    response = api.delete("b.steward", f"/dataset-versions/{v2}/files/{inherited['file_id']}")
    assert response.status_code == 204, response.text
    assert rows(db, "SELECT 1 FROM catalog.dataset_files WHERE dataset_version_id = :v", v=v2) == []
    assert _objects(api)[src["storage_key"]] == DATA["data/a.csv"]


def test_reupload_over_inherited_path_keeps_old_object(api: CatalogApi, db: PgUrls) -> None:
    v1, v2, src = _published_with_draft_inheriting(api, db)
    [inherited] = rows(db, "SELECT file_id FROM catalog.dataset_files WHERE dataset_version_id = :v", v=v2)
    new = {"data/a.csv": b"x,y\n9,9\n"}
    body = upload_files(api, db, str(v2), new)  # inherited row is replaceable: no 409 CONFLICT
    [row] = rows(db, "SELECT * FROM catalog.dataset_files WHERE dataset_version_id = :v", v=v2)
    assert row["file_id"] == inherited["file_id"]  # replaced in place, not a second row for the path
    assert row["inherited_from_file_id"] is None and row["status"] == "VERIFIED"
    # D-039: the new object lives under the new upload session's key, never the published one.
    assert row["storage_key"] != src["storage_key"]
    assert str(row["upload_session_id"]) == body["upload_session_id"]
    assert str(row["upload_session_id"]) in row["storage_key"] and str(v2) in row["storage_key"]
    assert _objects(api)[src["storage_key"]] == DATA["data/a.csv"]
    assert _objects(api)[row["storage_key"]] == new["data/a.csv"]


def test_failed_upload_over_inherited_path_keeps_published_object(api: CatalogApi, db: PgUrls) -> None:
    """A size mismatch removes only the session-owned object of the new upload (D-039)."""
    v1, v2, src = _published_with_draft_inheriting(api, db)
    session_body = start_upload(api, str(v2), {"data/a.csv": b"x,y\n9,9\n"})
    put_uploaded(api, db, session_body, {"data/a.csv": b"x,y\n9,9,9,9\n"})  # wrong size
    assert complete(api, session_body["upload_session_id"]).status_code == 200
    [row] = rows(db, "SELECT * FROM catalog.dataset_files WHERE dataset_version_id = :v", v=v2)
    assert (row["status"], row["failure_code"]) == ("FAILED", "SIZE_MISMATCH")
    assert row["storage_key"] not in _objects(api)
    assert _objects(api)[src["storage_key"]] == DATA["data/a.csv"]
    # And deleting the failed row afterwards does not touch the published object either.
    assert api.delete("b.steward", f"/dataset-versions/{v2}/files/{row['file_id']}").status_code == 204
    assert _objects(api)[src["storage_key"]] == DATA["data/a.csv"]


def test_reupload_over_own_row_removes_superseded_object(api: CatalogApi, db: PgUrls) -> None:
    """D-039 orphan cleanup still happens when nothing else shares the old session's object."""
    _, version_id = new_draft(api)
    session_body = start_upload(api, version_id, DATA)
    put_uploaded(api, db, session_body, {"data/a.csv": b"wrong size!"})
    assert complete(api, session_body["upload_session_id"]).status_code == 200
    [failed] = rows(db, "SELECT * FROM catalog.dataset_files WHERE dataset_version_id = :v", v=version_id)
    assert failed["status"] == "FAILED"
    memory_store(api.deps.storage, "inst-b").put(failed["storage_key"], b"stale", "text/csv")
    upload_files(api, db, version_id, DATA)
    [row] = rows(db, "SELECT * FROM catalog.dataset_files WHERE dataset_version_id = :v", v=version_id)
    assert row["storage_key"] != failed["storage_key"]
    assert failed["storage_key"] not in _objects(api)
    assert _objects(api)[row["storage_key"]] == DATA["data/a.csv"]


def test_deleting_last_reference_schedules_cleanup(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    upload_files(api, db, version_id, DATA)
    [row] = rows(db, "SELECT * FROM catalog.dataset_files WHERE dataset_version_id = :v", v=version_id)
    assert row["storage_key"] in _objects(api)
    assert (
        api.delete("b.steward", f"/dataset-versions/{version_id}/files/{row['file_id']}").status_code == 204
    )
    assert row["storage_key"] not in _objects(api)


def test_release_objects_counts_remaining_references(db: PgUrls, api: CatalogApi) -> None:
    v1, v2, src = _published_with_draft_inheriting(api, db)
    with session_factory(db.app)() as session, session.begin():
        session.execute(text("DELETE FROM catalog.dataset_files WHERE dataset_version_id = :v"), {"v": v2})
        assert release_objects(session, [src]) == []  # v1's row still references the object


def test_release_objects_returns_unreferenced_object(db: PgUrls, api: CatalogApi) -> None:
    _, version_id = new_draft(api)
    upload_files(api, db, version_id, DATA)
    [row] = rows(db, "SELECT * FROM catalog.dataset_files WHERE dataset_version_id = :v", v=version_id)
    with session_factory(db.app)() as session, session.begin():
        session.execute(text("DELETE FROM catalog.dataset_files WHERE file_id = :f"), {"f": row["file_id"]})
        [target] = release_objects(session, [row, row])  # duplicates collapse to one object
        assert (target.bucket, target.key, target.multipart_upload_id) == (
            row["storage_bucket"],
            row["storage_key"],
            None,
        )
        session.rollback()
    assert row["storage_key"] in _objects(api)  # release_objects never deletes; the caller does after commit


def test_concurrent_releases_of_one_object_serialize(db: PgUrls, api: CatalogApi) -> None:
    """Two transactions each remove one of two rows sharing an object: exactly one sees zero references."""
    _, version_id = new_draft(api)
    upload_files(api, db, version_id, DATA)
    [row] = rows(db, "SELECT * FROM catalog.dataset_files WHERE dataset_version_id = :v", v=version_id)
    twin = new_id()
    execute(
        db,
        "INSERT INTO catalog.dataset_files (file_id, dataset_version_id, upload_session_id, path, size_bytes, sha256,"
        " media_type, storage_bucket, storage_key, status, scan_status) SELECT :id, dataset_version_id,"
        " upload_session_id, 'data/twin.csv', size_bytes, sha256, media_type, storage_bucket, storage_key, status,"
        " scan_status FROM catalog.dataset_files WHERE file_id = :f",
        id=twin,
        f=row["file_id"],
    )
    results: list[int] = []
    errors: list[BaseException] = []
    barrier = threading.Barrier(2)

    def remove(file_id: UUID) -> None:
        try:
            with session_factory(db.app)() as session, session.begin():
                [old] = (
                    session.execute(
                        text("SELECT * FROM catalog.dataset_files WHERE file_id = :f"), {"f": file_id}
                    )
                    .mappings()
                    .all()
                )
                session.execute(text("DELETE FROM catalog.dataset_files WHERE file_id = :f"), {"f": file_id})
                barrier.wait(10)  # both deletes are in flight, neither committed
                results.append(len(release_objects(session, [old])))
        except BaseException as exc:  # surfaced below; a thread exception would otherwise be lost
            errors.append(exc)

    threads = [threading.Thread(target=remove, args=(fid,)) for fid in (row["file_id"], twin)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(20)
    assert errors == []
    assert sorted(results) == [0, 1]


def test_require_inheritable_accepts_published_rows_of_the_same_dataset(db: PgUrls, api: CatalogApi) -> None:
    v1, v2, src = _published_with_draft_inheriting(api, db)
    with session_factory(db.app)() as session:
        require_inheritable(session, [src["file_id"]], to_version_id=v2)
        require_inheritable(session, [], to_version_id=v2)


def test_require_inheritable_rejects_other_dataset_and_drafts(db: PgUrls, api: CatalogApi) -> None:
    v1, v2, src = _published_with_draft_inheriting(api, db)
    other = insert_version(db, insert_dataset(db), label="v1")
    [draft_row] = rows(db, "SELECT file_id FROM catalog.dataset_files WHERE dataset_version_id = :v", v=v2)
    with session_factory(db.app)() as session:
        with pytest.raises(InheritanceViolation):
            require_inheritable(session, [src["file_id"]], to_version_id=other)  # another dataset
        with pytest.raises(InheritanceViolation):
            require_inheritable(session, [draft_row["file_id"]], to_version_id=v2)  # a DRAFT row
        with pytest.raises(InheritanceViolation):
            require_inheritable(session, [new_id()], to_version_id=v2)  # unknown file
