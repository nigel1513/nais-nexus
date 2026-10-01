"""Queries shared by services, jobs and public ports."""

from collections.abc import Sequence
from typing import Any, cast
from uuid import UUID

from sqlalchemy import CursorResult, Result, exists, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.catalog.tables import (
    dataset_files,
    dataset_versions,
    datasets,
    index_queue,
    readiness_summaries,
)
from api.platform import clock

PRIMARY_PROFILES: tuple[str, ...] = ("TABULAR_ML_BASIC", "GENERIC_BASIC")  # D-028 order


def must(row: RowMapping | None, what: str) -> RowMapping:
    if row is None:
        raise RuntimeError(f"{what} disappeared inside its own transaction")
    return row


def rowcount(result: Result[Any]) -> int:
    return int(cast(CursorResult[Any], result).rowcount)


def load_dataset(session: Session, dataset_id: UUID, *, for_update: bool = False) -> RowMapping | None:
    published = (
        exists()
        .where(
            dataset_versions.c.dataset_id == datasets.c.dataset_id, dataset_versions.c.status == "PUBLISHED"
        )
        .label("has_published_version")
    )
    stmt = select(datasets, published).where(datasets.c.dataset_id == dataset_id)
    if for_update:
        stmt = stmt.with_for_update(of=datasets)
    return session.execute(stmt).mappings().first()


def load_version(session: Session, version_id: UUID, *, for_update: bool = False) -> RowMapping | None:
    stmt = select(dataset_versions).where(dataset_versions.c.dataset_version_id == version_id)
    if for_update:
        stmt = stmt.with_for_update()
    return session.execute(stmt).mappings().first()


def files_of_versions(session: Session, version_ids: Sequence[UUID]) -> dict[UUID, list[RowMapping]]:
    result: dict[UUID, list[RowMapping]] = {version_id: [] for version_id in version_ids}
    if not version_ids:
        return result
    stmt = (
        select(dataset_files)
        .where(dataset_files.c.dataset_version_id.in_(list(version_ids)))
        .order_by(dataset_files.c.dataset_version_id, dataset_files.c.path.collate("C"))
    )
    for row in session.execute(stmt).mappings():
        result[row["dataset_version_id"]].append(row)
    return result


def latest_published_version(session: Session, dataset_id: UUID) -> RowMapping | None:
    stmt = (
        select(dataset_versions)
        .where(dataset_versions.c.dataset_id == dataset_id, dataset_versions.c.status == "PUBLISHED")
        .order_by(dataset_versions.c.published_at.desc(), dataset_versions.c.dataset_version_id.desc())
        .limit(1)
    )
    return session.execute(stmt).mappings().first()


def readiness_overall(session: Session, version_ids: Sequence[UUID]) -> dict[UUID, str | None]:
    """M03 §4.5 primary profile rule: TABULAR_ML_BASIC COMPLETED, else GENERIC_BASIC COMPLETED, else None."""
    result: dict[UUID, str | None] = {version_id: None for version_id in version_ids}
    if not version_ids:
        return result
    stmt = select(
        readiness_summaries.c.dataset_version_id,
        readiness_summaries.c.profile_id,
        readiness_summaries.c.overall_status,
    ).where(
        readiness_summaries.c.dataset_version_id.in_(list(version_ids)),
        readiness_summaries.c.run_status == "COMPLETED",
        readiness_summaries.c.profile_id.in_(PRIMARY_PROFILES),
    )
    by_version: dict[UUID, dict[str, str | None]] = {}
    for row in session.execute(stmt):
        by_version.setdefault(row.dataset_version_id, {})[row.profile_id] = row.overall_status
    for version_id, profiles in by_version.items():
        for profile in PRIMARY_PROFILES:
            if profile in profiles:
                result[version_id] = profiles[profile]
                break
    return result


def enqueue_index(session: Session, dataset_id: UUID) -> None:
    """M03 §4.6: in the same transaction as the data change; the drain job indexes and deletes the row."""
    now = clock.now()
    stmt = pg_insert(index_queue).values(
        dataset_id=dataset_id, enqueued_at=now, attempts=0, next_attempt_at=now
    )
    session.execute(
        stmt.on_conflict_do_update(
            index_elements=[index_queue.c.dataset_id],
            set_={"enqueued_at": now, "attempts": 0, "next_attempt_at": now},
        )
    )
