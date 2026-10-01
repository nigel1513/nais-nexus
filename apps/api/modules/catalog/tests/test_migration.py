import pytest
from sqlalchemy.exc import DBAPIError

from api.modules.catalog.tests.support import (
    SHA_A,
    execute,
    insert_dataset,
    insert_file,
    insert_version,
    rows,
)
from api.platform.testing.fixtures import PgUrls


def test_catalog_schema_is_migrated_with_its_own_version_table(db: PgUrls) -> None:
    assert rows(db, "SELECT version_num FROM catalog.alembic_version") == [{"version_num": "catalog_0001"}]
    tables = {
        r["table_name"]
        for r in rows(db, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'catalog'")
    }
    assert {
        "datasets",
        "dataset_versions",
        "dataset_files",
        "upload_sessions",
        "readiness_summaries",
        "index_queue",
        "processed_events",
    } <= tables


def test_published_version_rejects_every_change_but_withdrawal(db: PgUrls) -> None:  # M03-AT-12 (DB part)
    dataset_id = insert_dataset(db)
    version_id = insert_version(db, dataset_id, published=True, files=[("data/a.csv", 10, SHA_A)])
    for sql in (
        "UPDATE catalog.dataset_versions SET change_note = 'x' WHERE dataset_version_id = :v",
        "UPDATE catalog.dataset_versions SET status = 'DRAFT' WHERE dataset_version_id = :v",
        "DELETE FROM catalog.dataset_versions WHERE dataset_version_id = :v",
    ):
        with pytest.raises(DBAPIError, match="immutable"):
            execute(db, sql, v=version_id)
    assert (
        execute(
            db,
            "UPDATE catalog.dataset_versions SET status = 'WITHDRAWN', updated_at = now() WHERE dataset_version_id = :v",
            v=version_id,
        )
        == 1
    )
    with pytest.raises(DBAPIError, match="immutable"):
        execute(
            db,
            "UPDATE catalog.dataset_versions SET status = 'PUBLISHED' WHERE dataset_version_id = :v",
            v=version_id,
        )


def test_files_of_a_published_version_are_immutable(db: PgUrls) -> None:
    version_id = insert_version(db, insert_dataset(db), published=True, files=[("data/a.csv", 10, SHA_A)])
    with pytest.raises(DBAPIError, match="immutable"):
        execute(
            db, "UPDATE catalog.dataset_files SET size_bytes = 11 WHERE dataset_version_id = :v", v=version_id
        )
    with pytest.raises(DBAPIError, match="immutable"):
        execute(db, "DELETE FROM catalog.dataset_files WHERE dataset_version_id = :v", v=version_id)
    with pytest.raises(DBAPIError, match="immutable"):
        insert_file(db, version_id, path="data/b.csv")


def test_draft_files_can_change(db: PgUrls) -> None:
    version_id = insert_version(db, insert_dataset(db))
    insert_file(db, version_id, path="data/a.csv", status="PENDING")
    assert (
        execute(
            db,
            "UPDATE catalog.dataset_files SET status = 'FAILED', failure_code = 'OBJECT_MISSING' WHERE dataset_version_id = :v",
            v=version_id,
        )
        == 1
    )
    assert execute(db, "DELETE FROM catalog.dataset_files WHERE dataset_version_id = :v", v=version_id) == 1


def test_sensitive_datasets_are_capped_at_30_days_by_the_database(db: PgUrls) -> None:
    with pytest.raises(DBAPIError, match="ck_datasets_sensitive_max_days"):
        insert_dataset(db, access_level="SENSITIVE", max_grant_days=60)


def test_published_version_needs_manifest_and_snapshot(db: PgUrls) -> None:
    dataset_id = insert_dataset(db)
    with pytest.raises(DBAPIError, match="ck_versions_published"):
        execute(
            db,
            "INSERT INTO catalog.dataset_versions (dataset_version_id, dataset_id, version_label, status, created_by)"
            " VALUES (gen_random_uuid(), :d, 'v9', 'PUBLISHED', :d)",
            d=dataset_id,
        )


def test_version_labels_are_unique_per_dataset(db: PgUrls) -> None:
    dataset_id = insert_dataset(db)
    insert_version(db, dataset_id, label="v1")
    with pytest.raises(DBAPIError, match="uq_versions_label"):
        insert_version(db, dataset_id, label="v1")
    insert_version(db, insert_dataset(db), label="v1")


@pytest.mark.parametrize("path", ["../x.csv", "/x.csv", "a//x.csv", "a/./x.csv"])
def test_unsafe_file_paths_are_rejected_by_the_database(db: PgUrls, path: str) -> None:
    version_id = insert_version(db, insert_dataset(db))
    with pytest.raises(DBAPIError, match="ck_files_path"):
        insert_file(db, version_id, path=path)
