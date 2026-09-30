"""Helpers for module migrations (call inside an Alembic upgrade())."""

from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID


def create_processed_events(schema: str, *, per_handler: bool = False) -> None:
    """Consumer idempotency table used by api.platform.event_bus.claim_event (D-006).

    per_handler=False: PK (event_id), one claim per module. per_handler=True: PK (event_id, handler), one claim
    per handler; then call claim_event(..., handler="<name>").
    """
    columns: list[sa.Column[Any]] = [sa.Column("event_id", UUID(as_uuid=True), primary_key=True)]
    if per_handler:
        columns.append(sa.Column("handler", sa.Text, primary_key=True))
    op.create_table(
        "processed_events",
        *columns,
        sa.Column("event_type", sa.Text, nullable=False),
        sa.Column(
            "processed_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")
        ),
        schema=schema,
    )
