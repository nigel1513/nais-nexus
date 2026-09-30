"""Helpers for module migrations (call inside an Alembic upgrade())."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID


def create_processed_events(schema: str) -> None:
    """Consumer idempotency table used by api.platform.event_bus.claim_event (D-006)."""
    op.create_table(
        "processed_events",
        sa.Column("event_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("event_type", sa.Text, nullable=False),
        sa.Column(
            "processed_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")
        ),
        schema=schema,
    )
