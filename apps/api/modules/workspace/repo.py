"""SQL for workspace tables (Core). Callers own the transaction."""

from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import func, insert, select, tuple_, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.workspace.tables import comments, dataset_activity, hub_access_requests, inputs, threads

SortKey = tuple[datetime, UUID]


def live_inputs(session: Session, project_id: UUID) -> list[RowMapping]:
    stmt = (
        select(inputs)
        .where(inputs.c.project_id == project_id, inputs.c.removed_at.is_(None))
        .order_by(inputs.c.added_at, inputs.c.input_id)
    )
    return list(session.execute(stmt).mappings())


def load_live_input(
    session: Session, project_id: UUID, input_id: UUID, *, for_update: bool = False
) -> RowMapping | None:
    stmt = select(inputs).where(
        inputs.c.input_id == input_id,
        inputs.c.project_id == project_id,
        inputs.c.removed_at.is_(None),
    )
    if for_update:
        stmt = stmt.with_for_update()
    return session.execute(stmt).mappings().first()


def live_input_for_dataset(session: Session, project_id: UUID, dataset_id: UUID) -> RowMapping | None:
    stmt = select(inputs.c.input_id).where(
        inputs.c.project_id == project_id,
        inputs.c.dataset_id == dataset_id,
        inputs.c.removed_at.is_(None),
    )
    return session.execute(stmt).mappings().first()


def insert_input(session: Session, **values: Any) -> RowMapping:
    return session.execute(insert(inputs).values(**values).returning(inputs)).mappings().one()


def update_input(session: Session, input_id: UUID, **values: Any) -> RowMapping:
    stmt = update(inputs).where(inputs.c.input_id == input_id).values(**values).returning(inputs)
    return session.execute(stmt).mappings().one()


def live_input_counts(session: Session) -> dict[UUID, int]:
    """dataset_id -> number of projects that currently pin it (one live input per project and dataset)."""
    stmt = (
        select(inputs.c.dataset_id, func.count())
        .where(inputs.c.removed_at.is_(None))
        .group_by(inputs.c.dataset_id)
    )
    return {dataset_id: int(count) for dataset_id, count in session.execute(stmt)}


def live_inputs_of_dataset(session: Session, dataset_id: UUID) -> list[RowMapping]:
    stmt = (
        select(inputs.c.project_id, inputs.c.added_at)
        .where(inputs.c.dataset_id == dataset_id, inputs.c.removed_at.is_(None))
        .order_by(inputs.c.added_at.desc(), inputs.c.project_id)
    )
    return list(session.execute(stmt).mappings())


# ---------------------------------------------------------------- threads


def insert_thread(session: Session, **values: Any) -> RowMapping:
    return session.execute(insert(threads).values(**values).returning(threads)).mappings().one()


def load_thread(session: Session, thread_id: UUID, *, for_update: bool = False) -> RowMapping | None:
    stmt = select(threads).where(threads.c.thread_id == thread_id)
    if for_update:
        stmt = stmt.with_for_update()
    return session.execute(stmt).mappings().first()


def update_thread(session: Session, thread_id: UUID, **values: Any) -> RowMapping:
    stmt = update(threads).where(threads.c.thread_id == thread_id).values(**values).returning(threads)
    return session.execute(stmt).mappings().one()


def list_threads(
    session: Session,
    *,
    project_id: UUID | None = None,
    scope: str | None = None,
    target_id: UUID | None = None,
    resolved: bool | None,
    after: SortKey | None,
    limit: int,
) -> list[RowMapping]:
    """Newest activity first; `after` is the (last_comment_at, thread_id) of the previous page's last row."""
    stmt = select(threads)
    if project_id is not None:
        stmt = stmt.where(threads.c.project_id == project_id)
    else:
        stmt = stmt.where(threads.c.scope == scope, threads.c.target_id == target_id)
    if resolved is not None:
        stmt = stmt.where(threads.c.resolved.is_(resolved))
    if after is not None:
        stmt = stmt.where(tuple_(threads.c.last_comment_at, threads.c.thread_id) < tuple_(*after))
    stmt = stmt.order_by(threads.c.last_comment_at.desc(), threads.c.thread_id.desc()).limit(limit)
    return list(session.execute(stmt).mappings())


def insert_comment(session: Session, **values: Any) -> RowMapping:
    return session.execute(insert(comments).values(**values).returning(comments)).mappings().one()


def list_comments(
    session: Session, thread_id: UUID, *, after: SortKey | None, limit: int
) -> list[RowMapping]:
    """Oldest first; `after` is the (created_at, comment_id) of the previous page's last row."""
    stmt = select(comments).where(comments.c.thread_id == thread_id)
    if after is not None:
        stmt = stmt.where(tuple_(comments.c.created_at, comments.c.comment_id) > tuple_(*after))
    stmt = stmt.order_by(comments.c.created_at, comments.c.comment_id).limit(limit)
    return list(session.execute(stmt).mappings())


# ---------------------------------------------------------------- hub read models


def record_access_request(session: Session, access_request_id: UUID, dataset_id: UUID, at: datetime) -> None:
    stmt = pg_insert(hub_access_requests).values(
        access_request_id=access_request_id, dataset_id=dataset_id, requested_at=at
    )
    session.execute(stmt.on_conflict_do_nothing(index_elements=[hub_access_requests.c.access_request_id]))


def access_request_counts(session: Session, since: datetime) -> dict[UUID, int]:
    stmt = (
        select(hub_access_requests.c.dataset_id, func.count())
        .where(hub_access_requests.c.requested_at >= since)
        .group_by(hub_access_requests.c.dataset_id)
    )
    return {dataset_id: int(count) for dataset_id, count in session.execute(stmt)}


def record_activity(session: Session, **values: Any) -> None:
    stmt = pg_insert(dataset_activity).values(**values)
    session.execute(stmt.on_conflict_do_nothing(index_elements=[dataset_activity.c.source_event_id]))


def activity_page(
    session: Session, dataset_id: UUID, *, after: SortKey | None, limit: int
) -> list[RowMapping]:
    """Newest first; `after` is the (occurred_at, activity_id) of the previous page's last row."""
    stmt = select(dataset_activity).where(dataset_activity.c.dataset_id == dataset_id)
    if after is not None:
        stmt = stmt.where(
            tuple_(dataset_activity.c.occurred_at, dataset_activity.c.activity_id) < tuple_(*after)
        )
    stmt = stmt.order_by(dataset_activity.c.occurred_at.desc(), dataset_activity.c.activity_id.desc()).limit(
        limit
    )
    return list(session.execute(stmt).mappings())
