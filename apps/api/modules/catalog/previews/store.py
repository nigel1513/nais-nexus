"""file_previews rows: queued inside the publish transaction (finalize_publish)."""

from collections.abc import Iterable
from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, and_, delete, func, literal, or_, select
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


# The same bytes fail the same way again; TIMEOUT / GENERATION_FAILED may be transient (load, memory), so the
# inherited file is profiled anew instead.
DETERMINISTIC_FAILURES = ("UNPARSEABLE",)


def inherit_previews(session: Session, version_id: UUID) -> int:
    """Inherited files are the same stored object as their source: copy the source's finished preview row (READY,
    or FAILED with a deterministic failure code; spec §3.3b, Ruling S6). The copy belongs to the new version
    (`dataset_version_id`). Any other source (PENDING, transient failure) is not copied, so `queue_previews` queues
    the inherited file on its own. Returns the number of rows copied."""
    src = file_previews.alias("src")
    columns = [c.name for c in file_previews.c]
    values: list[ColumnElement[Any]] = []
    for name in columns:
        if name == "file_id":
            values.append(dataset_files.c.file_id)
        elif name == "dataset_version_id":
            values.append(literal(version_id, file_previews.c.dataset_version_id.type).label(name))
        elif name == "created_at":
            values.append(func.now().label(name))
        else:
            values.append(src.c[name])
    inserted = session.execute(
        pg_insert(file_previews)
        .from_select(
            columns,
            select(*values)
            .select_from(dataset_files.join(src, src.c.file_id == dataset_files.c.inherited_from_file_id))
            .where(
                dataset_files.c.dataset_version_id == version_id,
                or_(
                    src.c.status == "READY",
                    and_(src.c.status == "FAILED", src.c.failure_code.in_(DETERMINISTIC_FAILURES)),
                ),
            ),
        )
        .on_conflict_do_nothing(index_elements=[file_previews.c.file_id])
        .returning(file_previews.c.file_id)
    ).all()
    return len(inserted)


def drop_previews(session: Session, file_ids: Iterable[UUID]) -> None:
    """Shared-object protocol (f): a draft row replaced in place (same file_id, new object) or deleted loses its
    preview row first (FK without cascade; a kept row would describe the old object)."""
    ids = list(file_ids)
    if ids:
        session.execute(delete(file_previews).where(file_previews.c.file_id.in_(ids)))


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
        inserted = session.execute(
            pg_insert(file_previews)
            .values(file_id=row.file_id, dataset_version_id=row.dataset_version_id)
            .on_conflict_do_nothing(index_elements=[file_previews.c.file_id])
            .returning(file_previews.c.file_id)
        ).all()
        queued += len(inserted)
    return queued
