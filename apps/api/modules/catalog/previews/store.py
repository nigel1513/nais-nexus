"""file_previews rows: queued inside the publish transaction (finalize_publish)."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from api.modules.catalog.previews.profile import table_format
from api.modules.catalog.tables import dataset_files, dataset_versions, file_previews


def queue_previews(session: Session, version_id: UUID) -> int:
    files = session.execute(
        select(dataset_files.c.file_id, dataset_files.c.path).where(
            dataset_files.c.dataset_version_id == version_id
        )
    ).all()
    tabular = [f.file_id for f in files if table_format(f.path)]
    for file_id in tabular:
        session.execute(
            pg_insert(file_previews)
            .values(file_id=file_id, dataset_version_id=version_id)
            .on_conflict_do_nothing(index_elements=[file_previews.c.file_id])
        )
    return len(tabular)


def backfill_previews(session: Session) -> int:
    """Queue file_previews rows for tabular files of PUBLISHED versions that have none (versions published before
    catalog_0003). Idempotent: existing rows are never touched. Returns the number of rows queued."""
    missing = session.execute(
        select(dataset_files.c.file_id, dataset_files.c.path, dataset_files.c.dataset_version_id)
        .join(dataset_versions, dataset_versions.c.dataset_version_id == dataset_files.c.dataset_version_id)
        .outerjoin(file_previews, file_previews.c.file_id == dataset_files.c.file_id)
        .where(
            dataset_versions.c.status == "PUBLISHED",
            dataset_files.c.status == "VERIFIED",
            file_previews.c.file_id.is_(None),
        )
    ).all()
    queued = 0
    for row in missing:
        if not table_format(row.path):
            continue
        result = session.execute(
            pg_insert(file_previews)
            .values(file_id=row.file_id, dataset_version_id=row.dataset_version_id)
            .on_conflict_do_nothing(index_elements=[file_previews.c.file_id])
        )
        queued += result.rowcount  # type: ignore[attr-defined]
    return queued
