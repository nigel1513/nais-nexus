"""SQL for workspace tables (Core). Callers own the transaction."""

from collections.abc import Sequence
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import func, insert, select, tuple_, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.workspace.tables import (
    comments,
    dataset_activity,
    hub_access_requests,
    inputs,
    output_files,
    output_lineage_inputs,
    outputs,
    recipe_versions,
    recipes,
    run_inputs,
    runs,
    threads,
)

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


# ---------------------------------------------------------------- outputs

READY = "READY"


def insert_output(
    session: Session,
    output: dict[str, Any],
    files: list[dict[str, Any]],
    lineage: list[dict[str, Any]],
) -> RowMapping:
    row = session.execute(insert(outputs).values(**output).returning(outputs)).mappings().one()
    output_id = row["output_id"]
    session.execute(
        insert(output_files), [f | {"output_id": output_id, "position": i} for i, f in enumerate(files)]
    )
    if lineage:
        session.execute(
            insert(output_lineage_inputs),
            [entry | {"output_id": output_id, "position": i} for i, entry in enumerate(lineage)],
        )
    return row


def load_output(
    session: Session, project_id: UUID, output_id: UUID, *, for_update: bool = False
) -> RowMapping | None:
    """Any status (upload sessions included); callers decide what an UPLOADING row means."""
    stmt = select(outputs).where(outputs.c.output_id == output_id, outputs.c.project_id == project_id)
    if for_update:
        stmt = stmt.with_for_update()
    return session.execute(stmt).mappings().first()


def ready_output_project(session: Session, output_id: UUID) -> UUID | None:
    stmt = select(outputs.c.project_id).where(outputs.c.output_id == output_id, outputs.c.status == READY)
    return session.execute(stmt).scalar_one_or_none()


def update_output(session: Session, output_id: UUID, **values: Any) -> RowMapping:
    stmt = update(outputs).where(outputs.c.output_id == output_id).values(**values).returning(outputs)
    return session.execute(stmt).mappings().one()


def list_ready_outputs(
    session: Session, project_id: UUID, *, kind: str | None, after: SortKey | None, limit: int
) -> list[RowMapping]:
    """Completed outputs, newest first; `after` is the (created_at, output_id) of the previous page's last row."""
    stmt = select(outputs).where(outputs.c.project_id == project_id, outputs.c.status == READY)
    if kind is not None:
        stmt = stmt.where(outputs.c.kind == kind)
    if after is not None:
        stmt = stmt.where(tuple_(outputs.c.created_at, outputs.c.output_id) < tuple_(*after))
    stmt = stmt.order_by(outputs.c.created_at.desc(), outputs.c.output_id.desc()).limit(limit)
    return list(session.execute(stmt).mappings())


def files_of(session: Session, output_ids: list[UUID]) -> dict[UUID, list[RowMapping]]:
    found: dict[UUID, list[RowMapping]] = {i: [] for i in output_ids}
    if output_ids:
        stmt = (
            select(output_files)
            .where(output_files.c.output_id.in_(output_ids))
            .order_by(output_files.c.output_id, output_files.c.position)
        )
        for row in session.execute(stmt).mappings():
            found[row["output_id"]].append(row)
    return found


def lineage_of(session: Session, output_ids: list[UUID]) -> dict[UUID, list[RowMapping]]:
    found: dict[UUID, list[RowMapping]] = {i: [] for i in output_ids}
    if output_ids:
        stmt = (
            select(output_lineage_inputs)
            .where(output_lineage_inputs.c.output_id.in_(output_ids))
            .order_by(output_lineage_inputs.c.output_id, output_lineage_inputs.c.position)
        )
        for row in session.execute(stmt).mappings():
            found[row["output_id"]].append(row)
    return found


def live_inputs_by_id(
    session: Session, project_id: UUID, input_ids: Sequence[UUID]
) -> dict[UUID, RowMapping]:
    """The live (not removed) inputs of the project among input_ids."""
    if not input_ids:
        return {}
    stmt = select(inputs).where(
        inputs.c.project_id == project_id,
        inputs.c.input_id.in_(list(input_ids)),
        inputs.c.removed_at.is_(None),
    )
    return {row["input_id"]: row for row in session.execute(stmt).mappings()}


# ---------------------------------------------------------------- recipes

ACTIVE_RUN = ("QUEUED", "RUNNING")


def insert_recipe(session: Session, **values: Any) -> RowMapping:
    row = session.execute(insert(recipes).values(**values).returning(recipes)).mappings().one()
    _insert_recipe_version(session, row)
    return row


def _insert_recipe_version(session: Session, row: RowMapping) -> None:
    session.execute(
        insert(recipe_versions).values(
            recipe_id=row["recipe_id"],
            version=row["version"],
            name=row["name"],
            input_ids=row["input_ids"],
            steps=row["steps"],
            saved_by=row["updated_by"],
            saved_at=row["updated_at"],
        )
    )


def save_recipe_version(session: Session, recipe_id: UUID, **values: Any) -> RowMapping:
    """Update the live row (values include the new version) and record that version."""
    stmt = update(recipes).where(recipes.c.recipe_id == recipe_id).values(**values).returning(recipes)
    row = session.execute(stmt).mappings().one()
    _insert_recipe_version(session, row)
    return row


def soft_delete_recipe(session: Session, recipe_id: UUID, at: datetime) -> None:
    session.execute(update(recipes).where(recipes.c.recipe_id == recipe_id).values(deleted_at=at))


def load_recipe(
    session: Session, project_id: UUID, recipe_id: UUID, *, for_update: bool = False
) -> RowMapping | None:
    stmt = select(recipes).where(
        recipes.c.recipe_id == recipe_id, recipes.c.project_id == project_id, recipes.c.deleted_at.is_(None)
    )
    if for_update:
        stmt = stmt.with_for_update()
    return session.execute(stmt).mappings().first()


def list_recipes(session: Session, project_id: UUID) -> list[RowMapping]:
    stmt = (
        select(recipes)
        .where(recipes.c.project_id == project_id, recipes.c.deleted_at.is_(None))
        .order_by(recipes.c.updated_at.desc(), recipes.c.recipe_id.desc())
    )
    return list(session.execute(stmt).mappings())


def live_recipe_project(session: Session, recipe_id: UUID) -> UUID | None:
    stmt = select(recipes.c.project_id).where(
        recipes.c.recipe_id == recipe_id, recipes.c.deleted_at.is_(None)
    )
    return session.execute(stmt).scalar_one_or_none()


def load_recipe_version(session: Session, recipe_id: UUID, version: int) -> RowMapping | None:
    stmt = select(recipe_versions).where(
        recipe_versions.c.recipe_id == recipe_id, recipe_versions.c.version == version
    )
    return session.execute(stmt).mappings().first()


# ---------------------------------------------------------------- runs


def active_run(session: Session, recipe_id: UUID) -> RowMapping | None:
    stmt = select(runs).where(runs.c.recipe_id == recipe_id, runs.c.status.in_(ACTIVE_RUN))
    return session.execute(stmt).mappings().first()


def insert_run(session: Session, run: dict[str, Any], pinned: list[dict[str, Any]]) -> RowMapping:
    row = session.execute(insert(runs).values(**run).returning(runs)).mappings().one()
    session.execute(
        insert(run_inputs), [p | {"run_id": row["run_id"], "position": i} for i, p in enumerate(pinned)]
    )
    return row


def load_run(session: Session, project_id: UUID, run_id: UUID) -> RowMapping | None:
    stmt = select(runs).where(runs.c.run_id == run_id, runs.c.project_id == project_id)
    return session.execute(stmt).mappings().first()


def load_run_by_id(session: Session, run_id: UUID, *, for_update: bool = False) -> RowMapping | None:
    stmt = select(runs).where(runs.c.run_id == run_id)
    if for_update:
        stmt = stmt.with_for_update()
    return session.execute(stmt).mappings().first()


def update_run(
    session: Session, run_id: UUID, *, from_statuses: Sequence[str], **values: Any
) -> RowMapping | None:
    """Guarded transition: only a run currently in one of from_statuses changes (None otherwise)."""
    stmt = (
        update(runs)
        .where(runs.c.run_id == run_id, runs.c.status.in_(list(from_statuses)))
        .values(**values)
        .returning(runs)
    )
    return session.execute(stmt).mappings().first()


def pinned_inputs(session: Session, run_id: UUID) -> list[RowMapping]:
    stmt = select(run_inputs).where(run_inputs.c.run_id == run_id).order_by(run_inputs.c.position)
    return list(session.execute(stmt).mappings())


def list_runs(
    session: Session,
    project_id: UUID,
    *,
    recipe_id: UUID | None,
    statuses: Sequence[str] | None,
    after: SortKey | None,
    limit: int,
) -> list[RowMapping]:
    """Newest first; `after` is the (queued_at, run_id) of the previous page's last row."""
    stmt = select(runs).where(runs.c.project_id == project_id)
    if recipe_id is not None:
        stmt = stmt.where(runs.c.recipe_id == recipe_id)
    if statuses:
        stmt = stmt.where(runs.c.status.in_(list(statuses)))
    if after is not None:
        stmt = stmt.where(tuple_(runs.c.queued_at, runs.c.run_id) < tuple_(*after))
    stmt = stmt.order_by(runs.c.queued_at.desc(), runs.c.run_id.desc()).limit(limit)
    return list(session.execute(stmt).mappings())


def stale_run_ids(session: Session, *, queued_before: datetime, running_before: datetime) -> list[UUID]:
    """Runs to give up on: QUEUED since before queued_before, or RUNNING since before running_before."""
    stmt = select(runs.c.run_id).where(_stale(queued_before, running_before))
    return list(session.execute(stmt).scalars())


def _stale(queued_before: datetime, running_before: datetime) -> Any:
    return ((runs.c.status == "QUEUED") & (runs.c.queued_at < queued_before)) | (
        (runs.c.status == "RUNNING") & (runs.c.started_at < running_before)
    )


def fail_if_stale(
    session: Session,
    run_id: UUID,
    *,
    queued_before: datetime,
    running_before: datetime,
    error: str,
    at: datetime,
) -> RowMapping | None:
    stmt = (
        update(runs)
        .where(runs.c.run_id == run_id, _stale(queued_before, running_before))
        .values(status="FAILED", error=error, finished_at=at)
        .returning(runs)
    )
    return session.execute(stmt).mappings().first()


def _waiting(sent_before: datetime) -> Any:
    return (runs.c.status == "QUEUED") & (
        func.coalesce(runs.c.last_enqueued_at, runs.c.queued_at) < sent_before
    )


def waiting_run_ids(session: Session, *, sent_before: datetime) -> list[UUID]:
    """QUEUED runs whose message was last sent before sent_before (it may have been lost)."""
    return list(session.execute(select(runs.c.run_id).where(_waiting(sent_before))).scalars())


def mark_resent(session: Session, run_id: UUID, *, sent_before: datetime, at: datetime) -> bool:
    """Guarded: only a run that is still QUEUED and still waiting is marked (and then re-sent)."""
    stmt = (
        update(runs)
        .where(runs.c.run_id == run_id, _waiting(sent_before))
        .values(last_enqueued_at=at)
        .returning(runs.c.run_id)
    )
    return session.execute(stmt).first() is not None
