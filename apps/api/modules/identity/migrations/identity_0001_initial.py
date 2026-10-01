"""identity initial schema

Revision ID: identity_0001
Revises:
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, UUID

revision = "identity_0001"
down_revision = None
branch_labels = None
depends_on = None

SCHEMA = "identity"
NOW = sa.text("now()")
EMPTY_TEXT_ARRAY = sa.text("'{}'::text[]")


def _timestamps() -> list[sa.Column[sa.DateTime]]:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
    ]


def upgrade() -> None:
    # pg_trgm is installed once in schema public by the platform (init.sql, M00 kickoff, W1-D2).
    # Modules never create extensions; they reference public.gin_trgm_ops.
    op.create_table(
        "organizations",
        sa.Column("organization_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("code", sa.String(32), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("ror_id", sa.String(64), nullable=True),
        sa.Column("homepage_url", sa.Text, nullable=True),
        *_timestamps(),
        sa.UniqueConstraint("code", name="uq_organizations_code"),
        sa.CheckConstraint("code ~ '^[a-z0-9-]{2,32}$'", name="ck_organizations_code"),
        sa.CheckConstraint(
            "type IN ('RESEARCH_INSTITUTE', 'UNIVERSITY', 'COMPANY', 'PLATFORM_OPERATOR')",
            name="ck_organizations_type",
        ),
        schema=SCHEMA,
    )
    op.create_table(
        "users",
        sa.Column("user_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("keycloak_sub", sa.String(64), nullable=False),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("display_name", sa.String(200), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="ACTIVE"),
        sa.Column("platform_roles", ARRAY(sa.Text), nullable=False, server_default=EMPTY_TEXT_ARRAY),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.UniqueConstraint("keycloak_sub", name="uq_users_keycloak_sub"),
        sa.UniqueConstraint("email", name="uq_users_email"),
        sa.CheckConstraint("email = lower(email)", name="ck_users_email_lower"),
        sa.CheckConstraint("status IN ('ACTIVE', 'DISABLED')", name="ck_users_status"),
        sa.CheckConstraint(
            "platform_roles <@ ARRAY['PLATFORM_ADMIN']::text[]", name="ck_users_platform_roles"
        ),
        schema=SCHEMA,
    )
    op.create_table(
        "organization_memberships",
        sa.Column("membership_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("identity.users.user_id"), nullable=False),
        sa.Column(
            "organization_id",
            UUID(as_uuid=True),
            sa.ForeignKey("identity.organizations.organization_id"),
            nullable=False,
        ),
        sa.Column("roles", ARRAY(sa.Text), nullable=False, server_default=EMPTY_TEXT_ARRAY),
        sa.Column("status", sa.String(16), nullable=False, server_default="ACTIVE"),
        *_timestamps(),
        sa.Column("updated_by", UUID(as_uuid=True), nullable=True),
        sa.UniqueConstraint("user_id", name="uq_memberships_user"),
        sa.CheckConstraint(
            "roles <@ ARRAY['ORG_ADMIN', 'DATA_STEWARD', 'RESOURCE_MANAGER']::text[]",
            name="ck_memberships_roles",
        ),
        sa.CheckConstraint("status IN ('ACTIVE', 'DISABLED')", name="ck_memberships_status"),
        schema=SCHEMA,
    )
    op.create_table(
        "user_sessions",
        sa.Column("session_id", sa.String(64), primary_key=True),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("identity.users.user_id"), nullable=False),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        schema=SCHEMA,
    )
    op.execute(
        "CREATE INDEX ix_users_display_name_trgm ON identity.users "
        "USING gin (display_name public.gin_trgm_ops)"
    )
    op.create_index(
        "ix_users_email_prefix",
        "users",
        ["email"],
        schema=SCHEMA,
        postgresql_ops={"email": "text_pattern_ops"},
    )
    op.create_index(
        "ix_memberships_org_status", "organization_memberships", ["organization_id", "status"], schema=SCHEMA
    )
    op.create_index(
        "ix_memberships_roles", "organization_memberships", ["roles"], schema=SCHEMA, postgresql_using="gin"
    )
    op.create_index(
        "ix_user_sessions_user", "user_sessions", ["user_id", sa.text("first_seen_at DESC")], schema=SCHEMA
    )


def downgrade() -> None:
    op.drop_table("user_sessions", schema=SCHEMA)
    op.drop_table("organization_memberships", schema=SCHEMA)
    op.drop_table("users", schema=SCHEMA)
    op.drop_table("organizations", schema=SCHEMA)
