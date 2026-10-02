"""SQL for workspace tables (Core). Callers own the transaction."""

from typing import Any
from uuid import UUID

from sqlalchemy import insert, select, update
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.workspace.tables import inputs


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
