import resource
from dataclasses import replace
from uuid import UUID

from api.modules.catalog.previews.jobs import dispatch_previews, generate_preview_job
from api.modules.catalog.previews.store import backfill_previews
from api.modules.catalog.settings import CatalogSettings
from api.modules.catalog.tests.support import execute, rows
from api.modules.catalog.tests.support_api import CatalogApi, assert_error, new_draft, publish_draft
from api.modules.catalog.tests.support_upload import upload_files
from api.modules.catalog.tests.test_preview_sandbox import plain_page_bomb
from api.platform.db import session_factory
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls

DATA = b"sample_id,temperature_c,material\n" + b"".join(
    f"S{i},{20 + i % 7}.5,{'AL' if i % 2 else 'CU'}\n".encode() for i in range(300)
)
SCHEMA = (
    b'{"resources":[{"path":"data/m.csv","schema":{"fields":[{"name":"temperature_c","type":"number",'
    b'"unit":"Cel","description":"temp"}]}}]}'
)


def published_with_preview(
    api: CatalogApi, db: PgUrls, access_level: str = "CONTROLLED", files: dict[str, bytes] | None = None
) -> dict[str, str]:
    _, version_id = new_draft(api, access_level=access_level)
    upload_files(
        api, db, version_id, files or {"data/m.csv": DATA, "_schema.json": SCHEMA, "README.md": b"# r\n"}
    )
    assert publish_draft(api, version_id).status_code == 200
    listed = api.get("b.steward", f"/dataset-versions/{version_id}").json()["files"]
    return {f["path"]: f["file_id"] for f in listed}


def test_publish_queues_only_tabular_files(api: CatalogApi, db: PgUrls) -> None:
    files = published_with_preview(api, db)
    queued = rows(db, "SELECT file_id, status FROM catalog.file_previews")
    assert [(str(r["file_id"]), r["status"]) for r in queued] == [(files["data/m.csv"], "PENDING")]


def test_profile_pending_then_ready(api: CatalogApi, db: PgUrls) -> None:
    files = published_with_preview(api, db)
    pending = api.get("b.researcher", f"/dataset-files/{files['data/m.csv']}/profile").json()
    assert pending["status"] == "PENDING" and pending["columns"] == []
    assert_matches_response("getFileProfile", 200, pending)
    assert generate_preview_job(UUID(files["data/m.csv"]), deps=api.deps) == "READY"
    profile = api.get("b.researcher", f"/dataset-files/{files['data/m.csv']}/profile")
    assert profile.status_code == 200
    body = profile.json()
    assert_matches_response("getFileProfile", 200, body)
    assert (body["format"], body["rows_sampled"], body["truncated"]) == ("csv", 300, False)
    temp = {c["name"]: c for c in body["columns"]}["temperature_c"]
    assert (temp["type"], temp["unit"], temp["description"]) == ("number", "Cel", "temp")
    readme = api.get("b.researcher", f"/dataset-files/{files['README.md']}/profile").json()
    assert readme["status"] == "UNSUPPORTED"
    assert_matches_response("getFileProfile", 200, readme)
    # a second run is a no-op (at-least-once delivery)
    assert generate_preview_job(UUID(files["data/m.csv"]), deps=api.deps) == "SKIPPED"


def test_preview_requires_download_permission(api: CatalogApi, db: PgUrls) -> None:
    files = published_with_preview(api, db, access_level="CONTROLLED")
    generate_preview_job(UUID(files["data/m.csv"]), deps=api.deps)
    url = f"/dataset-files/{files['data/m.csv']}/preview"
    error = assert_error("getFilePreview", api.get("a.researcher", url), 403, "FORBIDDEN")
    assert error["details"]["reason"] == "DOWNLOAD_PERMISSION_REQUIRED"
    assert "S1" not in str(error)
    assert api.get("a.researcher", f"/dataset-files/{files['data/m.csv']}/profile").status_code == 200
    own = api.get("b.researcher", url)
    assert own.status_code == 200
    assert_matches_response("getFilePreview", 200, own.json())
    assert len(own.json()["rows"]) == 100
    assert api.get("platform.admin", url).status_code == 200
    assert api.get(None, url).status_code == 401


def test_preview_of_pending_and_unsupported_files(api: CatalogApi, db: PgUrls) -> None:
    files = published_with_preview(api, db)
    for path, status in (("data/m.csv", "PENDING"), ("README.md", "UNSUPPORTED")):
        body = api.get("b.researcher", f"/dataset-files/{files[path]}/preview").json()
        assert_matches_response("getFilePreview", 200, body)
        assert (body["status"], body["rows"], body["columns"]) == (status, [], [])


def test_public_dataset_preview_for_everyone(api: CatalogApi, db: PgUrls) -> None:
    files = published_with_preview(api, db, access_level="PUBLIC")
    generate_preview_job(UUID(files["data/m.csv"]), deps=api.deps)
    assert api.get("a.researcher", f"/dataset-files/{files['data/m.csv']}/preview").status_code == 200


def test_grant_lookup_opens_preview(api: CatalogApi, db: PgUrls) -> None:
    files = published_with_preview(api, db)
    generate_preview_job(UUID(files["data/m.csv"]), deps=api.deps)
    asked: list[tuple[UUID, UUID]] = []

    class Granted:
        def has_active_grant(self, user_id: UUID, dataset_id: UUID) -> bool:
            asked.append((user_id, dataset_id))
            return True

    api.use(replace(api.deps, grants=Granted()))
    assert api.get("a.researcher", f"/dataset-files/{files['data/m.csv']}/preview").status_code == 200
    assert len(asked) == 1


def test_profile_contains_no_raw_values(api: CatalogApi, db: PgUrls) -> None:
    files = published_with_preview(api, db, access_level="PUBLIC")
    generate_preview_job(UUID(files["data/m.csv"]), deps=api.deps)
    text = api.get("a.researcher", f"/dataset-files/{files['data/m.csv']}/profile").text
    assert "S1" not in text and "AL" not in text and "21.5" not in text
    assert "histogram" not in text and "top_values" not in text and '"rows"' not in text
    preview = api.get("a.researcher", f"/dataset-files/{files['data/m.csv']}/preview").text
    assert "S1" in preview and "AL" in preview  # the same values are in the permission-gated preview


def test_cells_are_truncated(api: CatalogApi, db: PgUrls) -> None:
    long_cell = "x" * 5_000
    data = b"id,note\n" + b"".join(f"{i},{long_cell}\n".encode() for i in range(150))
    files = published_with_preview(api, db, files={"data/long.csv": data})
    assert generate_preview_job(UUID(files["data/long.csv"]), deps=api.deps) == "READY"
    body = api.get("b.researcher", f"/dataset-files/{files['data/long.csv']}/preview").json()
    assert_matches_response("getFilePreview", 200, body)
    assert len(body["rows"]) == 100 and body["rows_truncated"] is False
    assert all(len(cell) <= 200 for row in body["rows"] for cell in row if cell is not None)
    assert body["rows"][0][1] == long_cell[:200]
    stored = rows(db, "SELECT pg_column_size(preview) AS n FROM catalog.file_previews")[0]["n"]
    assert stored <= 256 << 10


def test_invisible_file_is_404_and_draft_files_hidden(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    upload_files(api, db, version_id, {"data/m.csv": DATA})
    file_id = api.get("b.steward", f"/dataset-versions/{version_id}").json()["files"][0]["file_id"]
    assert_error(
        "getFileProfile", api.get("a.researcher", f"/dataset-files/{file_id}/profile"), 404, "NOT_FOUND"
    )
    assert_error(
        "getFilePreview", api.get("a.researcher", f"/dataset-files/{file_id}/preview"), 404, "NOT_FOUND"
    )
    assert api.get("b.researcher", f"/dataset-files/{file_id}/profile").status_code == 404  # DRAFT
    assert api.get("b.steward", f"/dataset-files/{file_id}/profile").json()["status"] == "UNSUPPORTED"
    missing = "00000000-0000-0000-0000-000000000000"
    assert_error(
        "getFileProfile", api.get("b.steward", f"/dataset-files/{missing}/profile"), 404, "NOT_FOUND"
    )


def test_dispatch_leases_and_gives_up_after_three_attempts(api: CatalogApi, db: PgUrls) -> None:
    files = published_with_preview(api, db)
    sent: list[str] = []
    for _ in range(4):
        execute(db, "UPDATE catalog.file_previews SET next_attempt_at = now() - interval '1 second'")
        dispatch_previews(api.deps, send=sent.append)
    [row] = rows(db, "SELECT status, failure_code, attempts FROM catalog.file_previews")
    assert len(sent) == 3 and row["status"] == "FAILED" and row["failure_code"] == "GENERATION_FAILED"
    assert sent == [files["data/m.csv"]] * 3


def test_dispatch_respects_the_lease(api: CatalogApi, db: PgUrls) -> None:
    published_with_preview(api, db)
    sent: list[str] = []
    assert dispatch_previews(api.deps, send=sent.append) == 1
    assert dispatch_previews(api.deps, send=sent.append) == 0  # leased for catalog_preview_lease_seconds
    [row] = rows(db, "SELECT attempts, next_attempt_at > now() AS leased FROM catalog.file_previews")
    assert row == {"attempts": 1, "leased": True}


def test_unparseable_file_fails_cleanly(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    upload_files(api, db, version_id, {"data/bad.csv": b"a\n" + b"x" * (2 << 20) + b"\n"})
    publish_draft(api, version_id)
    file_id = api.get("b.steward", f"/dataset-versions/{version_id}").json()["files"][0]["file_id"]
    assert generate_preview_job(UUID(file_id), deps=api.deps) == "FAILED"
    body = api.get("b.steward", f"/dataset-files/{file_id}/profile").json()
    assert (body["status"], body["failure_code"]) == ("FAILED", "UNPARSEABLE")
    assert_matches_response("getFileProfile", 200, body)


def test_missing_object_stays_pending_for_the_lease(api: CatalogApi, db: PgUrls) -> None:
    files = published_with_preview(api, db)
    [key] = rows(
        db,
        "SELECT storage_bucket, storage_key FROM catalog.dataset_files WHERE file_id = :f",
        f=files["data/m.csv"],
    )
    api.deps.storage.for_bucket(key["storage_bucket"]).delete(key["storage_key"])
    assert generate_preview_job(UUID(files["data/m.csv"]), deps=api.deps) == "PENDING"
    assert rows(db, "SELECT status FROM catalog.file_previews") == [{"status": "PENDING"}]


def test_hostile_parquet_over_the_memory_limit_fails_without_affecting_the_worker(
    api: CatalogApi, db: PgUrls
) -> None:
    files = published_with_preview(
        api, db, files={"data/bomb.parquet": plain_page_bomb(2_000_000_000), "data/m.csv": DATA}
    )
    api.use(replace(api.deps, settings=CatalogSettings(catalog_preview_memory_limit_bytes=1 << 30)))
    before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    assert generate_preview_job(UUID(files["data/bomb.parquet"]), deps=api.deps) == "FAILED"
    grown_mb = (resource.getrusage(resource.RUSAGE_SELF).ru_maxrss - before) // 1024
    assert grown_mb < 64  # the 2 GB allocation happened (and failed) in the child, never in the worker
    body = api.get("b.steward", f"/dataset-files/{files['data/bomb.parquet']}/profile").json()
    assert (body["status"], body["failure_code"]) == ("FAILED", "GENERATION_FAILED")
    assert_matches_response("getFileProfile", 200, body)
    # the same worker process goes on profiling other files
    assert generate_preview_job(UUID(files["data/m.csv"]), deps=api.deps) == "READY"


def test_dispatch_keeps_at_most_two_leases_in_flight(api: CatalogApi, db: PgUrls) -> None:
    from api.modules.catalog.previews.jobs import MAX_IN_FLIGHT

    files = published_with_preview(api, db, files={f"data/{n}.csv": DATA for n in "abcd"})
    assert len(files) == 4 and MAX_IN_FLIGHT == 2
    sent: list[str] = []
    assert dispatch_previews(api.deps, send=sent.append) == 2
    assert dispatch_previews(api.deps, send=sent.append) == 0  # both leases live: no new messages
    assert generate_preview_job(UUID(sent[0]), deps=api.deps) == "READY"  # one finishes: one slot frees
    assert dispatch_previews(api.deps, send=sent.append) == 1
    assert len(set(sent)) == 3
    attempts = rows(db, "SELECT attempts FROM catalog.file_previews ORDER BY attempts")
    assert [r["attempts"] for r in attempts] == [0, 1, 1, 1]


def test_actor_start_renews_the_lease(api: CatalogApi, db: PgUrls) -> None:
    files = published_with_preview(api, db)
    sent: list[str] = []
    assert dispatch_previews(api.deps, send=sent.append) == 1
    # the message waited in the queue until just before its lease ran out
    execute(db, "UPDATE catalog.file_previews SET next_attempt_at = now() + interval '1 second'")
    [key] = rows(
        db,
        "SELECT storage_bucket, storage_key FROM catalog.dataset_files WHERE file_id = :f",
        f=files["data/m.csv"],
    )
    api.deps.storage.for_bucket(key["storage_bucket"]).delete(key["storage_key"])  # keep the row PENDING
    assert generate_preview_job(UUID(files["data/m.csv"]), deps=api.deps) == "PENDING"
    [row] = rows(
        db, "SELECT next_attempt_at > now() + interval '500 seconds' AS renewed FROM catalog.file_previews"
    )
    assert row["renewed"] is True


def test_preview_actor_runs_on_its_dedicated_queue() -> None:
    from api.modules.catalog import MODULE
    from api.modules.catalog.previews.jobs import QUEUE, generate_preview_actor

    assert generate_preview_actor.queue_name == QUEUE == "catalog_previews"
    assert MODULE.dedicated_queues == {"catalog_previews": 1}


def test_backfill_queues_published_tabular_files_without_rows_idempotently(
    api: CatalogApi, db: PgUrls
) -> None:
    ids = published_with_preview(api, db)
    _, draft_version = new_draft(api)
    upload_files(api, db, draft_version, {"data/d.csv": DATA})  # DRAFT: must not be queued
    execute(db, "DELETE FROM catalog.file_previews")
    with session_factory(db.app)() as session, session.begin():
        assert backfill_previews(session) == 1
    with session_factory(db.app)() as session, session.begin():
        assert backfill_previews(session) == 0
    [row] = rows(db, "SELECT file_id, status FROM catalog.file_previews")
    assert (str(row["file_id"]), row["status"]) == (ids["data/m.csv"], "PENDING")
