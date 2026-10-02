"""workspace initial schema: pinned dataset inputs, consumer idempotency (M13)

Revision ID: workspace_0001
Revises:
"""

import sqlalchemy as sa
from alembic import op
from api.platform.migration_helpers import create_processed_events
from sqlalchemy.dialects.postgresql import UUID

revision = "workspace_0001"
down_revision = None
branch_labels = None
depends_on = None

SCHEMA = "workspace"
NOW = sa.text("now()")


def upgrade() -> None:
    op.create_table(
        "inputs",
        sa.Column("input_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("project_id", UUID(as_uuid=True), nullable=False),
        sa.Column("dataset_id", UUID(as_uuid=True), nullable=False),
        sa.Column("dataset_version_id", UUID(as_uuid=True), nullable=False),
        sa.Column("added_by", UUID(as_uuid=True), nullable=False),
        sa.Column("added_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("note", sa.Text, nullable=True),
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("note IS NULL OR char_length(note) <= 2000", name="ck_inputs_note_length"),
        schema=SCHEMA,
    )
    op.create_index(
        "uq_inputs_live_dataset",
        "inputs",
        ["project_id", "dataset_id"],
        unique=True,
        schema=SCHEMA,
        postgresql_where=sa.text("removed_at IS NULL"),
    )
    op.create_index("ix_inputs_dataset", "inputs", ["dataset_id"], schema=SCHEMA)
    create_processed_events(SCHEMA, per_handler=True)


def downgrade() -> None:
    op.drop_table("processed_events", schema=SCHEMA)
    op.drop_table("inputs", schema=SCHEMA)
