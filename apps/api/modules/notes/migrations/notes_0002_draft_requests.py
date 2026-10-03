"""notes: when the recorder (or the evening schedule) last asked for an LLM draft (draftNote: once per minute per note)

draft_requested_at is not note content: it is outside the hashed document and the guard trigger's locked columns,
and like draft_status it is only ever written while the note is DRAFT.

Revision ID: notes_0002
Revises: notes_0001
"""

import sqlalchemy as sa
from alembic import op

revision = "notes_0002"
down_revision = "notes_0001"
branch_labels = None
depends_on = None

SCHEMA = "notes"


def upgrade() -> None:
    op.add_column(
        "notes", sa.Column("draft_requested_at", sa.DateTime(timezone=True), nullable=True), schema=SCHEMA
    )


def downgrade() -> None:
    op.drop_column("notes", "draft_requested_at", schema=SCHEMA)
