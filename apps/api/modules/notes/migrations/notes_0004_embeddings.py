"""notes: one embedding per note version for searchNotes (bge-m3 vectors as real[]; cosine is computed in Python over
the caller's readable notes, a recorder's scope being a few thousand notes at most, so no pgvector)

Revision ID: notes_0004
Revises: notes_0003
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, UUID

revision = "notes_0004"
down_revision = "notes_0003"
branch_labels = None
depends_on = None

SCHEMA = "notes"


def upgrade() -> None:
    op.create_table(
        "embeddings",
        sa.Column(
            "note_id",
            UUID(as_uuid=True),
            sa.ForeignKey(f"{SCHEMA}.notes.note_id", ondelete="CASCADE"),  # a deleted DRAFT takes its vector
            primary_key=True,
        ),
        sa.Column("version", sa.Integer, nullable=False),
        sa.Column("vector", ARRAY(sa.REAL), nullable=False),  # empty for a note without searchable text
        sa.Column("text_hash", sa.Text, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("text_hash ~ '^[a-f0-9]{64}$'", name="ck_embeddings_text_hash"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("embeddings", schema=SCHEMA)
