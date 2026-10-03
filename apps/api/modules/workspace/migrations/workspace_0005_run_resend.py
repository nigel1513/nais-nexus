"""workspace runs: last time the run's Dramatiq message was sent (the sweeper re-sends long-waiting QUEUED runs)

Revision ID: workspace_0005
Revises: workspace_0004
"""

import sqlalchemy as sa
from alembic import op

revision = "workspace_0005"
down_revision = "workspace_0004"
branch_labels = None
depends_on = None

SCHEMA = "workspace"


def upgrade() -> None:
    op.add_column(
        "runs", sa.Column("last_enqueued_at", sa.DateTime(timezone=True), nullable=True), schema=SCHEMA
    )


def downgrade() -> None:
    op.drop_column("runs", "last_enqueued_at", schema=SCHEMA)
