"""catalog_0004: lineage columns, inherited rows, trigger refresh (spec §3.3b)."""

from uuid import UUID

import pytest
from alembic import command
from sqlalchemy.exc import DBAPIError

from api.modules.catalog.tests.support import execute, insert_dataset, insert_file, insert_version, rows
from api.platform.ids import new_id
from api.platform.testing.fixtures import PgUrls


def test_columns_and_index_exist(db: PgUrls) -> None:
    cols = {
        (r["table_name"], r["column_name"]): r["is_nullable"]
        for r in rows(
            db,
            "SELECT table_name, column_name, is_nullable FROM information_schema.columns "
            "WHERE table_schema = 'catalog' AND table_name IN ('dataset_versions', 'dataset_files')",
        )
    }
    for col in ("base_version_id", "source_version_id", "previous_version_id"):
        assert cols[("dataset_versions", col)] == "YES"
    assert cols[("dataset_files", "inherited_from_file_id")] == "YES"
    assert cols[("dataset_files", "upload_session_id")] == "YES"
    [idx] = rows(
        db, "SELECT indexdef FROM pg_indexes WHERE schemaname='catalog' AND indexname='ix_files_object'"
    )
    assert "(storage_bucket, storage_key)" in idx["indexdef"]


def test_file_row_needs_a_session_or_a_source(db: PgUrls) -> None:
    ds = insert_dataset(db)
    version = insert_version(db, ds)
    with pytest.raises(DBAPIError, match="ck_files_origin"):
        execute(
            db,
            "INSERT INTO catalog.dataset_files (file_id, dataset_version_id, path, size_bytes, sha256, media_type,"
            " storage_bucket, storage_key, status) VALUES (:id, :v, 'a.csv', 1, :sha, 'text/csv', 'b', 'k', 'VERIFIED')",
            id=new_id(),
            v=version,
            sha="a" * 64,
        )


def test_inherited_row_without_session_is_accepted(db: PgUrls) -> None:
    ds = insert_dataset(db)
    v1 = insert_version(db, ds, label="v1", published=True, files=[("a.csv", 10, "a" * 64)])
    [src] = rows(
        db, "SELECT file_id, storage_key FROM catalog.dataset_files WHERE dataset_version_id = :v", v=v1
    )
    draft = insert_version(db, ds, label="v2")
    assert (
        execute(
            db,
            "INSERT INTO catalog.dataset_files (file_id, dataset_version_id, inherited_from_file_id, path, size_bytes,"
            " sha256, media_type, storage_bucket, storage_key, status) VALUES (:id, :v, :src, 'a.csv', 10, :sha,"
            " 'text/csv', 'nais-inst-b', :key, 'VERIFIED')",
            id=new_id(),
            v=draft,
            src=src["file_id"],
            sha="a" * 64,
            key=src["storage_key"],
        )
        == 1
    )


def test_published_lineage_is_frozen(db: PgUrls) -> None:
    ds = insert_dataset(db)
    v1 = insert_version(db, ds, label="v1", published=True)
    v2 = insert_version(db, ds, label="v2", published=True)
    with pytest.raises(DBAPIError, match="immutable"):
        execute(
            db,
            "UPDATE catalog.dataset_versions SET previous_version_id = :p WHERE dataset_version_id = :v",
            p=v1,
            v=v2,
        )
    # WITHDRAW still allowed (status + updated_at only)
    execute(
        db,
        "UPDATE catalog.dataset_versions SET status='WITHDRAWN', updated_at=now() WHERE dataset_version_id=:v",
        v=v2,
    )


def test_draft_lineage_is_editable(db: PgUrls) -> None:
    ds = insert_dataset(db)
    v1 = insert_version(db, ds, label="v1", published=True)
    draft = insert_version(db, ds, label="v2")
    assert (
        execute(
            db,
            "UPDATE catalog.dataset_versions SET base_version_id = :b WHERE dataset_version_id = :v",
            b=v1,
            v=draft,
        )
        == 1
    )
    [row] = rows(
        db, "SELECT base_version_id FROM catalog.dataset_versions WHERE dataset_version_id = :v", v=draft
    )
    assert row["base_version_id"] == UUID(str(v1))
    assert insert_file(db, draft, path="a.csv")  # session-backed rows still insert


def test_downgrade_is_clean_without_inherited_rows_and_guarded_with_them(db: PgUrls) -> None:
    from api.modules.catalog import MODULE
    from api.platform.migrate import alembic_config, migration_targets

    (target,) = [t for t in migration_targets([MODULE]) if t.name == "catalog"]
    config = alembic_config(db.migrator, target)
    ds = insert_dataset(db)
    v1 = insert_version(db, ds, label="v1", published=True, files=[("a.csv", 10, "a" * 64)])
    [src] = rows(
        db, "SELECT file_id, storage_key FROM catalog.dataset_files WHERE dataset_version_id = :v", v=v1
    )
    draft = insert_version(db, ds, label="v2")
    execute(
        db,
        "INSERT INTO catalog.dataset_files (file_id, dataset_version_id, inherited_from_file_id, path, size_bytes,"
        " sha256, media_type, storage_bucket, storage_key, status) VALUES (:id, :v, :src, 'a.csv', 10, :sha,"
        " 'text/csv', 'nais-inst-b', :key, 'VERIFIED')",
        id=new_id(),
        v=draft,
        src=src["file_id"],
        sha="a" * 64,
        key=src["storage_key"],
    )
    with pytest.raises(NotImplementedError, match="cannot be downgraded"):
        command.downgrade(config, "catalog_0003")
    execute(db, "DELETE FROM catalog.dataset_files WHERE upload_session_id IS NULL")
    command.downgrade(config, "catalog_0003")
    assert rows(db, "SELECT 1 FROM information_schema.columns WHERE column_name = 'base_version_id'") == []
    command.upgrade(config, "head")
    assert rows(db, "SELECT version_num FROM catalog.alembic_version") == [{"version_num": "catalog_0004"}]
