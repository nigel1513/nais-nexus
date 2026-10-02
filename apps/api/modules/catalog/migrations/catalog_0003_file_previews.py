"""catalog Data Explorer previews (Wave 1.5 spec §7)

Revision ID: catalog_0003
Revises: catalog_0002
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "catalog_0003"
down_revision = "catalog_0002"
branch_labels = None
depends_on = None

S = "catalog"


def upgrade() -> None:
    # nais_app privileges come from ALTER DEFAULT PRIVILEGES in infra/docker/postgres/init.sql (as in catalog_0002)
    op.create_table(
        "file_previews",
        sa.Column(
            "file_id",
            UUID(as_uuid=True),
            sa.ForeignKey("catalog.dataset_files.file_id"),
            primary_key=True,
        ),
        sa.Column("dataset_version_id", UUID(as_uuid=True), nullable=False),
        sa.Column("status", sa.Text, nullable=False, server_default="PENDING"),
        sa.Column("failure_code", sa.Text, nullable=True),
        sa.Column("column_profile", JSONB, nullable=True),
        sa.Column("preview", JSONB, nullable=True),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column(
            "next_attempt_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")
        ),
        sa.Column("generated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("status IN ('PENDING','READY','FAILED')", name="ck_file_previews_status"),
        sa.CheckConstraint(
            "failure_code IS NULL OR failure_code IN ('UNPARSEABLE','TIMEOUT','GENERATION_FAILED')",
            name="ck_file_previews_failure",
        ),
        sa.CheckConstraint(
            "status <> 'READY' OR (column_profile IS NOT NULL AND preview IS NOT NULL)",
            name="ck_file_previews_ready",
        ),
        schema=S,
    )
    op.create_index(
        "ix_file_previews_pending",
        "file_previews",
        ["next_attempt_at"],
        schema=S,
        postgresql_where=sa.text("status = 'PENDING'"),
    )


def downgrade() -> None:
    op.drop_table("file_previews", schema=S)
