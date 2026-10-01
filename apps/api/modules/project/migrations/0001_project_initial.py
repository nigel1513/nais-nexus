"""project schema: projects, members, participating organizations

Revision ID: project_0001
Revises:
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, UUID

revision = "project_0001"
down_revision = None
branch_labels = None
depends_on = None

SCHEMA = "project"
NOW = sa.text("now()")


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("project_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("visibility", sa.String(16), nullable=False, server_default="PRIVATE"),
        sa.Column("status", sa.String(16), nullable=False, server_default="ACTIVE"),
        sa.Column("lead_organization_id", UUID(as_uuid=True), nullable=False),
        sa.Column("keywords", ARRAY(sa.Text), nullable=False, server_default=sa.text("'{}'::text[]")),
        sa.Column("start_date", sa.Date, nullable=True),
        sa.Column("end_date", sa.Date, nullable=True),
        sa.Column("created_by", UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("char_length(name) >= 2", name="ck_projects_name_length"),
        sa.CheckConstraint("char_length(description) <= 10000", name="ck_projects_description_length"),
        sa.CheckConstraint("visibility IN ('PRIVATE', 'PUBLIC')", name="ck_projects_visibility"),
        sa.CheckConstraint("status IN ('ACTIVE', 'ARCHIVED')", name="ck_projects_status"),
        sa.CheckConstraint("cardinality(keywords) <= 20", name="ck_projects_keywords_count"),
        sa.CheckConstraint(
            "end_date IS NULL OR start_date IS NULL OR end_date >= start_date", name="ck_projects_dates"
        ),
        schema=SCHEMA,
    )
    op.create_index("ix_projects_visibility_status", "projects", ["visibility", "status"], schema=SCHEMA)
    # pg_trgm lives in schema public, installed once by the platform (M00 kickoff, W1-D2); never CREATE EXTENSION here.
    op.execute(
        f"CREATE INDEX ix_projects_name_trgm ON {SCHEMA}.projects USING gin (name public.gin_trgm_ops)"
    )

    op.create_table(
        "project_members",
        sa.Column("project_member_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("project_id", UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", UUID(as_uuid=True), nullable=False),
        sa.Column("role", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="ACTIVE"),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("added_by", UUID(as_uuid=True), nullable=False),
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("removed_by", UUID(as_uuid=True), nullable=True),
        sa.Column("removal_reason", sa.Text, nullable=True),
        sa.ForeignKeyConstraint(
            ["project_id"], [f"{SCHEMA}.projects.project_id"], name="fk_project_members_project"
        ),
        sa.CheckConstraint(
            "role IN ('PROJECT_OWNER', 'PROJECT_ADMIN', 'RESEARCHER', 'VIEWER')",
            name="ck_project_members_role",
        ),
        sa.CheckConstraint("status IN ('ACTIVE', 'REMOVED')", name="ck_project_members_status"),
        schema=SCHEMA,
    )
    op.create_index(
        "ux_project_members_active",
        "project_members",
        ["project_id", "user_id"],
        unique=True,
        schema=SCHEMA,
        postgresql_where=sa.text("status = 'ACTIVE'"),
    )
    op.create_index("ix_project_members_user", "project_members", ["user_id", "status"], schema=SCHEMA)

    op.create_table(
        "project_organizations",
        sa.Column("project_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("organization_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("role", sa.String(8), nullable=False),
        sa.Column("active_member_count", sa.Integer, nullable=False, server_default="0"),
        sa.ForeignKeyConstraint(
            ["project_id"], [f"{SCHEMA}.projects.project_id"], name="fk_project_organizations_project"
        ),
        sa.CheckConstraint("role IN ('LEAD', 'PARTNER')", name="ck_project_organizations_role"),
        sa.CheckConstraint("active_member_count >= 0", name="ck_project_organizations_count"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("project_organizations", schema=SCHEMA)
    op.drop_table("project_members", schema=SCHEMA)
    op.drop_table("projects", schema=SCHEMA)
