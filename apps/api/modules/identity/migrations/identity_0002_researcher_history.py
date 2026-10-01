"""identity: NTIS researcher number + membership history (Wave 1.5 spec §3.0, §3.0b)

Revision ID: identity_0002
Revises: identity_0001
"""

import sqlalchemy as sa
from alembic import op

revision = "identity_0002"
down_revision = "identity_0001"
branch_labels = None
depends_on = None

SCHEMA = "identity"


def upgrade() -> None:
    op.add_column(
        "users", sa.Column("national_researcher_number", sa.String(8), nullable=True), schema=SCHEMA
    )
    op.create_check_constraint(
        "ck_users_ntis", "users", "national_researcher_number ~ '^[0-9]{8}$'", schema=SCHEMA
    )
    op.create_index(
        "uq_users_ntis",
        "users",
        ["national_researcher_number"],
        unique=True,
        schema=SCHEMA,
        postgresql_where=sa.text("national_researcher_number IS NOT NULL"),
    )
    op.add_column(
        "organization_memberships",
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        schema=SCHEMA,
    )
    op.add_column(
        "organization_memberships",
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )
    op.execute("UPDATE identity.organization_memberships SET started_at = created_at")
    op.drop_constraint("uq_memberships_user", "organization_memberships", schema=SCHEMA, type_="unique")
    op.create_index(
        "uq_memberships_current",
        "organization_memberships",
        ["user_id"],
        unique=True,
        schema=SCHEMA,
        postgresql_where=sa.text("ended_at IS NULL"),
    )
    op.create_index(
        "ix_memberships_user_history", "organization_memberships", ["user_id", "started_at"], schema=SCHEMA
    )
    op.create_check_constraint(
        "ck_memberships_ended",
        "organization_memberships",
        "ended_at IS NULL OR (status = 'DISABLED' AND ended_at >= started_at)",
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_constraint("ck_memberships_ended", "organization_memberships", schema=SCHEMA, type_="check")
    op.drop_index("ix_memberships_user_history", "organization_memberships", schema=SCHEMA)
    op.drop_index("uq_memberships_current", "organization_memberships", schema=SCHEMA)
    op.execute("DELETE FROM identity.organization_memberships WHERE ended_at IS NOT NULL")
    op.create_unique_constraint("uq_memberships_user", "organization_memberships", ["user_id"], schema=SCHEMA)
    op.drop_column("organization_memberships", "ended_at", schema=SCHEMA)
    op.drop_column("organization_memberships", "started_at", schema=SCHEMA)
    op.drop_index("uq_users_ntis", "users", schema=SCHEMA)
    op.drop_constraint("ck_users_ntis", "users", schema=SCHEMA, type_="check")
    op.drop_column("users", "national_researcher_number", schema=SCHEMA)
