"""rebaseDatasetVersion (spec §3.3b): a stale draft is re-applied on the latest PUBLISHED version, in place.

Shared-object protocol (b, d, e, f): rows are re-pointed (UPDATE), never copied from a draft; replaced rows lose
their previews first; their objects are released once, last, and removed after commit only when unreferenced."""

import threading
import time
from typing import Any
from uuid import UUID

from api.modules.catalog.schemas import UploadCompleteIn
from api.modules.catalog.service.completion import complete_upload_session
from api.modules.catalog.service.publish import publish_version
from api.modules.catalog.testing import memory_store
from api.modules.catalog.tests.support import execute, rows
from api.modules.catalog.tests.support_api import USERS, CatalogApi, assert_error, new_draft
from api.modules.catalog.tests.support_upload import put_uploaded, sha, start_upload, upload_files
from api.modules.catalog.tests.test_versioning_drafts import A1, draft, first_published, publish
from api.platform.db import session_factory
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


def _two_drafts(api: CatalogApi, db: PgUrls) -> tuple[str, str, str]:
    dataset_id, _ = first_published(api, db)
    a = draft(api, dataset_id, "v2-a")["dataset_version_id"]
    b = draft(api, dataset_id, "v2-b")["dataset_version_id"]
    return dataset_id, a, b


def _rebase(api: CatalogApi, version_id: str, body: dict[str, Any] | None = None) -> Any:
    return api.post(
        "b.steward", f"/dataset-versions/{version_id}/rebase", json=body if body is not None else {}
    )


def _ok(response: Any) -> dict[str, Any]:
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    assert_matches_response("rebaseDatasetVersion", 200, body)
    return body


def _rows(db: PgUrls, version_id: str) -> dict[str, dict[str, Any]]:
    return {
        r["path"]: r
        for r in rows(db, "SELECT * FROM catalog.dataset_files WHERE dataset_version_id = :v", v=version_id)
    }


def _store(api: CatalogApi) -> dict[str, bytes]:
    objects: dict[str, bytes] = memory_store(api.deps.storage, "inst-b").objects
    return objects


def test_clean_rebase_takes_latest_and_keeps_mine(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, a, b = _two_drafts(api, db)
    upload_files(api, db, a, {"README.md": b"# from a\n"})
    publish(api, a)
    upload_files(api, db, b, {"data/b-only.csv": b"q\n1\n"})
    before = _rows(db, b)
    a_rows = _rows(db, a)
    body = _ok(_rebase(api, b))
    assert body["base_version_id"] == a and body["base_is_latest"] is True
    files = {f["path"]: f for f in body["files"]}
    assert set(files) == {"README.md", "data/a.csv", "data/b-only.csv"}
    assert files["README.md"]["inherited"] is True  # took the latest content
    assert files["README.md"]["sha256"] == sha(b"# from a\n")
    assert files["data/b-only.csv"]["inherited"] is False
    after = _rows(db, b)
    # Re-pointed in place (protocol b/e): same row, now inheriting from the latest version's row.
    assert after["README.md"]["file_id"] == before["README.md"]["file_id"]
    assert after["README.md"]["inherited_from_file_id"] == a_rows["README.md"]["file_id"]
    assert after["README.md"]["storage_key"] == a_rows["README.md"]["storage_key"]
    assert after["data/b-only.csv"] == before["data/b-only.csv"]  # mine: untouched
    assert after["data/a.csv"] == before["data/a.csv"]  # unchanged everywhere
    assert before["README.md"]["storage_key"] in _store(api)  # still v1's object: kept
    api.patch("b.steward", f"/dataset-versions/{b}", json={"change_note": "after rebase"})
    assert api.post("b.steward", f"/dataset-versions/{b}/publish").status_code == 200


def test_rebase_conflict_requires_resolution(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, a, b = _two_drafts(api, db)
    upload_files(api, db, a, {"data/a.csv": b"x,y\n1,1\n"})
    publish(api, a)
    upload_files(api, db, b, {"data/a.csv": b"x,y\n2,2\n"})
    before = api.get("b.steward", f"/dataset-versions/{b}").json()
    before_rows = _rows(db, b)
    error = assert_error("rebaseDatasetVersion", _rebase(api, b), 409, "CONFLICT")
    assert error["details"] == {
        "latest_version_id": a,
        "conflicts": [
            {
                "path": "data/a.csv",
                "base": {"sha256": sha(A1["data/a.csv"]), "size_bytes": len(A1["data/a.csv"])},
                "mine": {"sha256": sha(b"x,y\n2,2\n"), "size_bytes": 8},
                "theirs": {"sha256": sha(b"x,y\n1,1\n"), "size_bytes": 8},
            }
        ],
    }
    assert api.get("b.steward", f"/dataset-versions/{b}").json() == before  # nothing changed
    assert _rows(db, b) == before_rows
    body = _ok(_rebase(api, b, {"resolutions": {"data/a.csv": "MINE"}}))
    mine = next(f for f in body["files"] if f["path"] == "data/a.csv")
    assert mine["inherited"] is False and mine["sha256"] == sha(b"x,y\n2,2\n")
    assert body["base_version_id"] == a
    assert _rows(db, b)["data/a.csv"] == before_rows["data/a.csv"]


def test_theirs_drops_the_draft_upload_and_its_preview(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, a, b = _two_drafts(api, db)
    upload_files(api, db, a, {"data/a.csv": b"x,y\n1,1\n"})
    publish(api, a)
    upload_files(api, db, b, {"data/a.csv": b"x,y\n2,2\n"})
    mine = _rows(db, b)["data/a.csv"]
    assert mine["storage_key"] in _store(api)
    execute(
        db,
        "INSERT INTO catalog.file_previews (file_id, dataset_version_id, status) VALUES (:f, :v, 'PENDING')",
        f=mine["file_id"],
        v=b,
    )
    body = _ok(_rebase(api, b, {"resolutions": {"data/a.csv": "THEIRS"}}))
    theirs = _rows(db, a)["data/a.csv"]
    row = _rows(db, b)["data/a.csv"]
    assert row["file_id"] == mine["file_id"]  # re-pointed, not copied
    assert row["inherited_from_file_id"] == theirs["file_id"]
    assert (row["storage_key"], row["sha256"], row["status"]) == (
        theirs["storage_key"],
        theirs["sha256"],
        "VERIFIED",
    )
    assert row["upload_session_id"] is None
    assert row["created_at"] == mine["created_at"] and row["updated_at"] > mine["updated_at"]
    assert row["verified_at"] == theirs["verified_at"]  # the object's verification travels with it
    assert rows(db, "SELECT 1 FROM catalog.file_previews WHERE file_id = :f", f=mine["file_id"]) == []
    assert mine["storage_key"] not in _store(api)  # only the draft referenced it: removed after commit
    assert theirs["storage_key"] in _store(api)
    assert next(f for f in body["files"] if f["path"] == "data/a.csv")["inherited"] is True


def test_deletes_on_either_side(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, _ = first_published(api, db)  # data/a.csv + README.md
    a = draft(api, dataset_id, "v2-a")["dataset_version_id"]
    b = draft(api, dataset_id, "v2-b")["dataset_version_id"]
    a_files = {
        f["path"]: f["file_id"] for f in api.get("b.steward", f"/dataset-versions/{a}").json()["files"]
    }
    b_files = {
        f["path"]: f["file_id"] for f in api.get("b.steward", f"/dataset-versions/{b}").json()["files"]
    }
    # latest removes README.md and adds data/new.csv; the draft removes data/a.csv and adds data/mine.csv
    assert api.delete("b.steward", f"/dataset-versions/{a}/files/{a_files['README.md']}").status_code == 204
    upload_files(api, db, a, {"data/new.csv": b"n\n1\n"})
    publish(api, a)
    assert api.delete("b.steward", f"/dataset-versions/{b}/files/{b_files['data/a.csv']}").status_code == 204
    upload_files(api, db, b, {"data/mine.csv": b"m\n1\n"})
    body = _ok(_rebase(api, b))
    files = {f["path"]: f for f in body["files"]}
    assert set(files) == {"data/new.csv", "data/mine.csv"}
    assert files["data/new.csv"]["inherited"] is True and files["data/mine.csv"]["inherited"] is False
    assert _rows(db, b)["data/new.csv"]["inherited_from_file_id"] == _rows(db, a)["data/new.csv"]["file_id"]


def test_delete_against_change_is_a_conflict(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, a, b = _two_drafts(api, db)
    upload_files(api, db, a, {"data/a.csv": b"x,y\n9,9\n"})
    publish(api, a)
    readme = next(
        f for f in api.get("b.steward", f"/dataset-versions/{b}").json()["files"] if f["path"] == "data/a.csv"
    )
    assert api.delete("b.steward", f"/dataset-versions/{b}/files/{readme['file_id']}").status_code == 204
    error = assert_error("rebaseDatasetVersion", _rebase(api, b), 409, "CONFLICT")
    [conflict] = error["details"]["conflicts"]
    assert conflict["path"] == "data/a.csv" and conflict["mine"] is None and conflict["theirs"] is not None
    body = _ok(_rebase(api, b, {"resolutions": {"data/a.csv": "MINE"}}))
    assert "data/a.csv" not in {f["path"] for f in body["files"]}  # stays deleted
    _ok(_rebase(api, b))  # now current: no-op


def test_null_base_draft_is_stale_and_rebases(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, first = new_draft(api)
    second = draft(api, dataset_id, "v1-alt")["dataset_version_id"]
    assert api.get("b.steward", f"/dataset-versions/{second}").json()["base_version_id"] is None
    upload_files(api, db, first, A1)
    publish(api, first)
    upload_files(api, db, second, {"data/a.csv": b"other\n", "data/mine.csv": b"m\n1\n"})
    assert api.get("b.steward", f"/dataset-versions/{second}").json()["base_is_latest"] is False
    error = assert_error("rebaseDatasetVersion", _rebase(api, second), 409, "CONFLICT")
    [conflict] = error["details"]["conflicts"]
    assert conflict["path"] == "data/a.csv" and conflict["base"] is None
    body = _ok(_rebase(api, second, {"resolutions": {"data/a.csv": "THEIRS"}}))
    files = {f["path"]: f["inherited"] for f in body["files"]}
    assert files == {"README.md": True, "data/a.csv": True, "data/mine.csv": False}
    assert body["base_version_id"] == first and body["base_is_latest"] is True


def test_unknown_resolution_path_is_422(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, a, b = _two_drafts(api, db)
    publish(api, a)
    before = _rows(db, b)
    error = assert_error(
        "rebaseDatasetVersion",
        _rebase(api, b, {"resolutions": {"nope.csv": "MINE"}}),
        422,
        "VALIDATION_FAILED",
    )
    assert error["details"]["fields"] == [
        {"field": "resolutions", "reason": "UNKNOWN_PATH", "paths": ["nope.csv"]}
    ]
    assert _rows(db, b) == before
    assert api.get("b.steward", f"/dataset-versions/{b}").json()["base_version_id"] != a


def test_invalid_resolution_body_is_422(api: CatalogApi, db: PgUrls) -> None:
    _, a, b = _two_drafts(api, db)
    publish(api, a)
    for body in (
        {"resolutions": {"data/a.csv": "BOTH"}},
        {"resolutions": {"bad path.csv": "MINE"}},
        {"other": 1},
    ):
        assert_error("rebaseDatasetVersion", _rebase(api, b, body), 422, "VALIDATION_FAILED")


def test_rebase_without_body_and_access(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, a, b = _two_drafts(api, db)
    publish(api, a)
    assert_error(
        "rebaseDatasetVersion",
        api.post("b.researcher", f"/dataset-versions/{b}/rebase", json={}),
        404,
        "NOT_FOUND",
    )
    assert_error(
        "rebaseDatasetVersion",
        api.post("a.steward", f"/dataset-versions/{b}/rebase", json={}),
        404,
        "NOT_FOUND",
    )
    assert_error("rebaseDatasetVersion", _rebase(api, a), 409, "DATASET_VERSION_IMMUTABLE")
    response = api.post("b.steward", f"/dataset-versions/{b}/rebase")  # no body at all
    assert _ok(response)["base_version_id"] == a


def test_rebase_refused_during_open_upload_and_noop_when_current(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, a, b = _two_drafts(api, db)
    start_upload(api, b, {"data/early.csv": b"e\n1\n"})
    before = _rows(db, b)
    # Already current: a no-op even while an upload is open (checked first).
    assert _ok(_rebase(api, b))["base_version_id"] == _ok(_rebase(api, a))["base_version_id"]
    assert _rows(db, b) == before
    publish(api, a)
    error = assert_error("rebaseDatasetVersion", _rebase(api, b), 409, "CONFLICT")
    assert "conflicts" not in (error.get("details") or {})
    assert _rows(db, b) == before
    # An expired (not yet swept) session no longer blocks.
    execute(
        db,
        "UPDATE catalog.upload_sessions SET expires_at = now() - interval '1 minute' WHERE dataset_version_id = :v",
        v=b,
    )
    assert _ok(_rebase(api, b))["base_version_id"] == a


def _waiting_locks(db: PgUrls) -> int:
    [row] = rows(
        db,
        "SELECT count(*) AS n FROM pg_locks WHERE NOT granted"
        " AND (database IS NULL OR database = (SELECT oid FROM pg_database WHERE datname = current_database()))",
    )
    return int(row["n"])


def _wait_until_blocked(db: PgUrls, worker: threading.Thread) -> bool:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline and worker.is_alive():
        if _waiting_locks(db):
            return True
        time.sleep(0.02)
    return False


def _hold_open(db: PgUrls, work: Any) -> tuple[threading.Thread, threading.Event, threading.Event, list[Any]]:
    """Run `work(session)` in a transaction that stays open until `release` is set."""
    done, release = threading.Event(), threading.Event()
    out: list[Any] = []

    def run() -> None:
        try:
            with session_factory(db.app)() as session, session.begin():
                out.append(work(session))
                done.set()
                assert release.wait(30)
        except BaseException as exc:
            out.append(exc)
            done.set()

    thread = threading.Thread(target=run)
    thread.start()
    return thread, done, release, out


def _in_thread(fn: Any) -> tuple[threading.Thread, list[Any]]:
    out: list[Any] = []

    def run() -> None:
        try:
            out.append(fn())
        except BaseException as exc:
            out.append(exc)

    thread = threading.Thread(target=run)
    thread.start()
    return thread, out


def test_rebase_waits_for_a_concurrent_publish_and_lands_on_it(api: CatalogApi, db: PgUrls) -> None:
    """Lock order version -> dataset (as publishDatasetVersion): the rebase waits on the dataset row the publisher
    holds and then sees the newly published version as latest."""
    dataset_id, x, b = _two_drafts(api, db)
    upload_files(api, db, x, {"README.md": b"# x\n"})
    publish(api, x)  # b is now stale
    a = draft(api, dataset_id, "v3-a")["dataset_version_id"]
    upload_files(api, db, a, {"data/a.csv": b"x,y\n3,3\n"})
    api.patch("b.steward", f"/dataset-versions/{a}", json={"change_note": "race"})
    publisher, published, release, out = _hold_open(
        db, lambda s: publish_version(s, api.deps, USERS["b.steward"], UUID(a))
    )
    assert published.wait(20) and not isinstance(out[0], BaseException), out
    rebaser, result = _in_thread(lambda: _rebase(api, b))
    blocked = _wait_until_blocked(db, rebaser)
    release.set()
    publisher.join(20)
    rebaser.join(20)
    assert blocked, "rebase did not wait for the publisher's dataset lock"
    body = _ok(result[0])
    assert body["base_version_id"] == a and body["base_is_latest"] is True
    files = {f["path"]: f for f in body["files"]}
    assert files["data/a.csv"]["sha256"] == sha(b"x,y\n3,3\n") and files["README.md"]["sha256"] == sha(
        b"# x\n"
    )


def test_publish_of_another_draft_waits_for_rebase(api: CatalogApi, db: PgUrls) -> None:
    """The other order: a publisher waits until the rebase committed; the rebased draft is then stale again."""
    from api.modules.catalog.schemas import RebaseIn
    from api.modules.catalog.service.rebase import rebase

    dataset_id, x, b = _two_drafts(api, db)
    publish(api, x)
    a = draft(api, dataset_id, "v3-a")["dataset_version_id"]
    api.patch("b.steward", f"/dataset-versions/{a}", json={"change_note": "race"})
    rebaser, rebased, release, out = _hold_open(
        db, lambda s: rebase(s, api.deps, USERS["b.steward"], UUID(b), RebaseIn())
    )
    assert rebased.wait(20) and not isinstance(out[0], BaseException), out
    publisher, result = _in_thread(lambda: api.post("b.steward", f"/dataset-versions/{a}/publish"))
    blocked = _wait_until_blocked(db, publisher)
    release.set()
    rebaser.join(20)
    publisher.join(20)
    assert blocked, "publish did not wait for the rebase's dataset lock"
    assert result[0].status_code == 200, result[0].text
    after = api.get("b.steward", f"/dataset-versions/{b}").json()
    assert after["base_version_id"] == x and after["base_is_latest"] is False


def test_rebase_waits_for_upload_completion_on_the_same_draft(api: CatalogApi, db: PgUrls) -> None:
    """Completion holds the draft's version lock: the rebase waits, then finds no open session and keeps the file."""
    _, a, b = _two_drafts(api, db)
    publish(api, a)
    data = {"data/late.csv": b"l\n1\n"}
    session_body = start_upload(api, b, data)
    parts = put_uploaded(api, db, session_body, data)
    completer, completed, release, out = _hold_open(
        db,
        lambda s: complete_upload_session(
            s,
            api.deps,
            USERS["b.steward"],
            UUID(session_body["upload_session_id"]),
            UploadCompleteIn.model_validate(parts),
        ),
    )
    assert completed.wait(20) and not isinstance(out[0], BaseException), out
    rebaser, result = _in_thread(lambda: _rebase(api, b))
    blocked = _wait_until_blocked(db, rebaser)
    release.set()
    completer.join(20)
    rebaser.join(20)
    assert blocked, "rebase did not wait for the completion's version lock"
    body = _ok(result[0])
    files = {f["path"]: f for f in body["files"]}
    assert body["base_version_id"] == a
    assert files["data/late.csv"]["inherited"] is False and files["data/late.csv"]["status"] == "VERIFIED"


def test_resolutions_are_capped_at_the_contract_limit(api: CatalogApi, db: PgUrls) -> None:
    _, a, b = _two_drafts(api, db)
    publish(api, a)
    too_many = {f"data/f{i}.csv": "MINE" for i in range(10_001)}
    error = assert_error(
        "rebaseDatasetVersion", _rebase(api, b, {"resolutions": too_many}), 422, "VALIDATION_FAILED"
    )
    [field] = error["details"]["fields"]
    assert field["field"] == "resolutions" and field["reason"] != "UNKNOWN_PATH"  # schema, not the service
    assert api.get("b.steward", f"/dataset-versions/{b}").json()["base_version_id"] != a


def test_unknown_paths_echo_is_capped(api: CatalogApi, db: PgUrls) -> None:
    _, a, b = _two_drafts(api, db)
    publish(api, a)
    unknown = {f"data/f{i:05d}.csv": "THEIRS" for i in range(10_000)}  # at the limit: reaches the service
    error = assert_error(
        "rebaseDatasetVersion", _rebase(api, b, {"resolutions": unknown}), 422, "VALIDATION_FAILED"
    )
    [field] = error["details"]["fields"]
    assert field["reason"] == "UNKNOWN_PATH" and field["paths_total"] == 10_000
    assert field["paths"] == [f"data/f{i:05d}.csv" for i in range(100)]
