"""notes: one row per Asia/Seoul day on which the evening draft schedule ran (claimed once; a worker that was down at
19:00 catches up at its first tick that evening)

Revision ID: notes_0003
Revises: notes_0002
"""

import sqlalchemy as sa
from alembic import op

revision = "notes_0003"
down_revision = "notes_0002"
branch_labels = None
depends_on = None

SCHEMA = "notes"


def upgrade() -> None:
    op.create_table(
        "daily_runs",
        sa.Column("run_date", sa.Date, primary_key=True),
        sa.Column("ran_at", sa.DateTime(timezone=True), nullable=False),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("daily_runs", schema=SCHEMA)
