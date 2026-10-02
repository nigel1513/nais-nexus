"""workspace recipes (versioned), runs and their pinned inputs

Revision ID: workspace_0004
Revises: workspace_0003
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID

revision = "workspace_0004"
down_revision = "workspace_0003"
branch_labels = None
depends_on = None

SCHEMA = "workspace"
NOW = sa.text("now()")
STATUSES = "('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')"


def upgrade() -> None:
    op.create_table(
        "recipes",
        sa.Column("recipe_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("project_id", UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("input_ids", ARRAY(UUID(as_uuid=True)), nullable=False),
        sa.Column("steps", JSONB, nullable=False),
        sa.Column("version", sa.Integer, nullable=False),
        sa.Column("created_by", UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("updated_by", UUID(as_uuid=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("char_length(name) BETWEEN 1 AND 200", name="ck_recipes_name_length"),
        sa.CheckConstraint("version >= 1", name="ck_recipes_version"),
        sa.CheckConstraint("cardinality(input_ids) BETWEEN 1 AND 10", name="ck_recipes_input_count"),
        sa.CheckConstraint("jsonb_typeof(steps) = 'array'", name="ck_recipes_steps_array"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_recipes_project_live",
        "recipes",
        ["project_id", sa.text("updated_at DESC")],
        schema=SCHEMA,
        postgresql_where=sa.text("deleted_at IS NULL"),
    )
    # every saved version, so a queued run executes exactly the version it pinned
    op.create_table(
        "recipe_versions",
        sa.Column(
            "recipe_id", UUID(as_uuid=True), sa.ForeignKey(f"{SCHEMA}.recipes.recipe_id"), nullable=False
        ),
        sa.Column("version", sa.Integer, nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("input_ids", ARRAY(UUID(as_uuid=True)), nullable=False),
        sa.Column("steps", JSONB, nullable=False),
        sa.Column("saved_by", UUID(as_uuid=True), nullable=False),
        sa.Column("saved_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.PrimaryKeyConstraint("recipe_id", "version", name="pk_recipe_versions"),
        schema=SCHEMA,
    )
    op.create_table(
        "runs",
        sa.Column("run_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("project_id", UUID(as_uuid=True), nullable=False),
        sa.Column("recipe_id", UUID(as_uuid=True), nullable=False),
        sa.Column("recipe_version", sa.Integer, nullable=False),
        sa.Column("status", sa.Text, nullable=False),
        sa.Column("started_by", UUID(as_uuid=True), nullable=False),
        sa.Column("started_by_organization_id", UUID(as_uuid=True), nullable=False),
        sa.Column("queued_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attempt", sa.Integer, nullable=False, server_default=sa.text("0")),
        sa.Column("input_rows", sa.BigInteger, nullable=True),
        sa.Column("output_rows", sa.BigInteger, nullable=True),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column(
            "output_id", UUID(as_uuid=True), sa.ForeignKey(f"{SCHEMA}.outputs.output_id"), nullable=True
        ),
        sa.ForeignKeyConstraint(
            ["recipe_id", "recipe_version"],
            [f"{SCHEMA}.recipe_versions.recipe_id", f"{SCHEMA}.recipe_versions.version"],
            name="fk_runs_recipe_version",
        ),
        sa.CheckConstraint(f"status IN {STATUSES}", name="ck_runs_status"),
        sa.CheckConstraint("error IS NULL OR char_length(error) <= 500", name="ck_runs_error_length"),
        sa.CheckConstraint("(status = 'SUCCEEDED') = (output_id IS NOT NULL)", name="ck_runs_output"),
        sa.CheckConstraint(
            "(status IN ('SUCCEEDED', 'FAILED')) = (finished_at IS NOT NULL)", name="ck_runs_finished"
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "uq_runs_one_active_per_recipe",
        "runs",
        ["recipe_id"],
        unique=True,
        schema=SCHEMA,
        postgresql_where=sa.text("status IN ('QUEUED', 'RUNNING')"),
    )
    op.create_index(
        "ix_runs_project_queued",
        "runs",
        ["project_id", sa.text("queued_at DESC"), sa.text("run_id DESC")],
        schema=SCHEMA,
    )
    op.create_table(
        "run_inputs",
        sa.Column("run_id", UUID(as_uuid=True), sa.ForeignKey(f"{SCHEMA}.runs.run_id"), nullable=False),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("input_id", UUID(as_uuid=True), nullable=False),
        sa.Column("dataset_id", UUID(as_uuid=True), nullable=False),
        sa.Column("dataset_version_id", UUID(as_uuid=True), nullable=False),
        sa.Column("dataset_title", sa.Text, nullable=False),
        sa.Column("version_label", sa.Text, nullable=False),
        sa.PrimaryKeyConstraint("run_id", "position", name="pk_run_inputs"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("run_inputs", schema=SCHEMA)
    op.drop_table("runs", schema=SCHEMA)
    op.drop_table("recipe_versions", schema=SCHEMA)
    op.drop_table("recipes", schema=SCHEMA)
