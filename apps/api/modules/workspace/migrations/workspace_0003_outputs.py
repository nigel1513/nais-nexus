"""workspace project outputs: upload sessions / outputs, their files and lineage inputs

Revision ID: workspace_0003
Revises: workspace_0002
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "workspace_0003"
down_revision = "workspace_0002"
branch_labels = None
depends_on = None

SCHEMA = "workspace"
NOW = sa.text("now()")
LEVELS = "('PUBLIC', 'INTERNAL', 'CONTROLLED', 'SENSITIVE')"
PUBLISH = "('NONE', 'PENDING', 'APPROVED', 'REJECTED', 'PUBLISHED')"


def upgrade() -> None:
    op.create_table(
        "outputs",
        sa.Column("output_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("project_id", UUID(as_uuid=True), nullable=False),
        sa.Column("kind", sa.Text, nullable=False),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("access_level", sa.Text, nullable=False),
        sa.Column("status", sa.Text, nullable=False),
        sa.Column("storage_org_code", sa.Text, nullable=True),
        sa.Column("produced_by_run_id", UUID(as_uuid=True), nullable=True),
        sa.Column("recipe_id", UUID(as_uuid=True), nullable=True),
        sa.Column("recipe_version", sa.Integer, nullable=True),
        sa.Column("publish_status", sa.Text, nullable=False, server_default=sa.text("'NONE'")),
        sa.Column("created_by", UUID(as_uuid=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("upload_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("kind IN ('DERIVED_DATASET', 'FILE')", name="ck_outputs_kind"),
        sa.CheckConstraint(f"access_level IN {LEVELS}", name="ck_outputs_access_level"),
        sa.CheckConstraint("status IN ('UPLOADING', 'READY')", name="ck_outputs_status"),
        sa.CheckConstraint(f"publish_status IN {PUBLISH}", name="ck_outputs_publish_status"),
        sa.CheckConstraint("char_length(title) BETWEEN 1 AND 300", name="ck_outputs_title_length"),
        sa.CheckConstraint("(status = 'READY') = (created_at IS NOT NULL)", name="ck_outputs_ready"),
        sa.CheckConstraint("recipe_version IS NULL OR recipe_version >= 1", name="ck_outputs_recipe_version"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_outputs_project_ready",
        "outputs",
        ["project_id", sa.text("created_at DESC"), sa.text("output_id DESC")],
        schema=SCHEMA,
        postgresql_where=sa.text("status = 'READY'"),
    )
    op.create_table(
        "output_files",
        sa.Column(
            "output_id", UUID(as_uuid=True), sa.ForeignKey(f"{SCHEMA}.outputs.output_id"), nullable=False
        ),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("size_bytes", sa.BigInteger, nullable=False),
        sa.Column("sha256", sa.Text, nullable=False),
        sa.Column("media_type", sa.Text, nullable=False),
        sa.Column("object_key", sa.Text, nullable=False),
        sa.PrimaryKeyConstraint("output_id", "position", name="pk_output_files"),
        sa.UniqueConstraint("output_id", "name", name="uq_output_files_name"),
        sa.CheckConstraint("size_bytes >= 0", name="ck_output_files_size"),
        sa.CheckConstraint("sha256 ~ '^[a-f0-9]{64}$'", name="ck_output_files_sha256"),
        schema=SCHEMA,
    )
    op.create_table(
        "output_lineage_inputs",
        sa.Column(
            "output_id", UUID(as_uuid=True), sa.ForeignKey(f"{SCHEMA}.outputs.output_id"), nullable=False
        ),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("input_id", UUID(as_uuid=True), nullable=False),
        sa.Column("dataset_id", UUID(as_uuid=True), nullable=False),
        sa.Column("dataset_version_id", UUID(as_uuid=True), nullable=False),
        sa.Column("dataset_title", sa.Text, nullable=False),
        sa.Column("version_label", sa.Text, nullable=False),
        sa.PrimaryKeyConstraint("output_id", "position", name="pk_output_lineage_inputs"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("output_lineage_inputs", schema=SCHEMA)
    op.drop_table("output_files", schema=SCHEMA)
    op.drop_table("outputs", schema=SCHEMA)
