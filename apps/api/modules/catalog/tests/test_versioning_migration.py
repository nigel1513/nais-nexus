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


@pytest.mark.parametrize("column", ["base_version_id", "source_version_id", "previous_version_id"])
def test_published_base_and_source_are_frozen(db: PgUrls, column: str) -> None:
    ds = insert_dataset(db)
    v1 = insert_version(db, ds, label="v1", published=True)
    v2 = insert_version(db, ds, label="v2", published=True)
    with pytest.raises(DBAPIError, match="immutable"):
        execute(
            db, f"UPDATE catalog.dataset_versions SET {column} = :p WHERE dataset_version_id = :v", p=v1, v=v2
        )
    with pytest.raises(DBAPIError, match="immutable"):  # nor in the same UPDATE as a withdrawal
        execute(
            db,
            f"UPDATE catalog.dataset_versions SET status = 'WITHDRAWN', {column} = :p WHERE dataset_version_id = :v",
            p=v1,
            v=v2,
        )


def test_publishing_a_draft_may_set_previous_version(db: PgUrls) -> None:
    """DRAFT -> PUBLISHED is the one transition that records lineage (Task 5 sets previous_version_id)."""
    ds = insert_dataset(db)
    v1 = insert_version(db, ds, label="v1", published=True)
    draft = insert_version(db, ds, label="v2")
    assert (
        execute(
            db,
            "UPDATE catalog.dataset_versions SET status = 'PUBLISHED', published_at = now(), published_by = :d,"
            " metadata_snapshot = '{}'::jsonb, manifest_sha256 = :m, file_count = 0, total_bytes = 0,"
            " base_version_id = :p, previous_version_id = :p WHERE dataset_version_id = :v",
            d=ds,
            m="0" * 64,
            p=v1,
            v=draft,
        )
        == 1
    )
    [row] = rows(
        db,
        "SELECT status, previous_version_id FROM catalog.dataset_versions WHERE dataset_version_id = :v",
        v=draft,
    )
    assert (row["status"], row["previous_version_id"]) == ("PUBLISHED", UUID(str(v1)))


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


def _catalog_config(db: PgUrls):  # type: ignore[no-untyped-def]
    from api.modules.catalog import MODULE
    from api.platform.migrate import alembic_config, migration_targets

    (target,) = [t for t in migration_targets([MODULE]) if t.name == "catalog"]
    return alembic_config(db.migrator, target)


def test_upgrade_backfills_lineage_on_populated_0003_data(db: PgUrls) -> None:
    """Versions published before catalog_0004 get previous_version_id (per dataset, by published_at, tie: id);
    a DRAFT with no base gets the latest PUBLISHED version published before it was created (none: stays NULL)."""
    from datetime import UTC, datetime

    config = _catalog_config(db)
    command.downgrade(config, "catalog_0003")
    t = lambda day, hour=0: datetime(2026, 1, day, hour, tzinfo=UTC)  # noqa: E731
    ds = insert_dataset(db)
    v1 = insert_version(
        db, ds, label="v1", published=True, files=[("a.csv", 10, "a" * 64)], published_at=t(1)
    )
    # v2a / v2b share one instant: the tie is broken by id
    v2a = insert_version(
        db, ds, label="v2a", published=True, files=[("a.csv", 10, "b" * 64)], published_at=t(2)
    )
    v2b = insert_version(
        db, ds, label="v2b", published=True, files=[("a.csv", 10, "c" * 64)], published_at=t(2)
    )
    first, second = sorted([v2a, v2b], key=str)
    v3 = insert_version(
        db, ds, label="v3", published=True, files=[("a.csv", 10, "d" * 64)], published_at=t(4)
    )
    execute(
        db, "UPDATE catalog.dataset_versions SET status = 'WITHDRAWN' WHERE dataset_version_id = :v", v=v3
    )
    early = insert_version(db, ds, label="d-early")  # created before anything was published
    mid = insert_version(db, ds, label="d-mid")  # created on day 3: base = the later of v2a/v2b
    for draft, created in ((early, t(1, 0).replace(year=2025)), (mid, t(3))):
        execute(
            db,
            "UPDATE catalog.dataset_versions SET created_at = :c WHERE dataset_version_id = :v",
            c=created,
            v=draft,
        )
    late = insert_version(db, ds, label="d-late")  # created now: base = latest PUBLISHED (v3 is WITHDRAWN)
    other = insert_dataset(db)
    lonely = insert_version(db, other, label="d-only")  # nothing published in its dataset
    command.upgrade(config, "head")
    lineage = {
        r["dataset_version_id"]: (r["previous_version_id"], r["base_version_id"], r["source_version_id"])
        for r in rows(
            db,
            "SELECT dataset_version_id, previous_version_id, base_version_id, source_version_id"
            " FROM catalog.dataset_versions",
        )
    }
    assert lineage[v1] == (None, None, None)
    assert lineage[first] == (v1, None, None)
    assert lineage[second] == (first, None, None)
    assert lineage[v3] == (second, None, None)  # WITHDRAWN keeps its place in the chain
    assert lineage[early] == (None, None, None)
    assert lineage[mid] == (None, second, None)
    assert lineage[late] == (None, second, None)
    assert lineage[lonely] == (None, None, None)
    # The immutability trigger is back on and covers the new columns.
    with pytest.raises(DBAPIError):
        execute(
            db,
            "UPDATE catalog.dataset_versions SET previous_version_id = NULL WHERE dataset_version_id = :v",
            v=first,
        )
    [trigger] = rows(db, "SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_versions_immutable'")
    assert trigger["tgenabled"] == "O"
