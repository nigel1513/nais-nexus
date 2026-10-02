"""workspace hub publication: publish requests and their per-organization approval slots

Revision ID: workspace_0006
Revises: workspace_0005
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "workspace_0006"
down_revision = "workspace_0005"
branch_labels = None
depends_on = None

SCHEMA = "workspace"


def upgrade() -> None:
    op.create_table(
        "publish_requests",
        sa.Column("request_id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "output_id", UUID(as_uuid=True), sa.ForeignKey(f"{SCHEMA}.outputs.output_id"), nullable=False
        ),
        sa.Column("project_id", UUID(as_uuid=True), nullable=False),
        sa.Column("status", sa.Text, nullable=False),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("description", sa.Text, nullable=False),
        sa.Column("created_by", UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("approved_by", UUID(as_uuid=True), nullable=True),
        sa.Column("approved_by_organization_id", UUID(as_uuid=True), nullable=True),
        sa.Column("planned_dataset_id", UUID(as_uuid=True), nullable=True),
        sa.Column("published_dataset_id", UUID(as_uuid=True), nullable=True),
        sa.Column("publication_status", sa.Text, nullable=True),
        sa.Column("publication_error", sa.Text, nullable=True),
        sa.Column("publication_claimed_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("publication_attempted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("publication_attempts", sa.Integer, nullable=False, server_default=sa.text("0")),
        sa.CheckConstraint(
            "status IN ('PENDING', 'APPROVED', 'REJECTED')", name="ck_publish_requests_status"
        ),
        sa.CheckConstraint(
            "publication_status IS NULL OR publication_status IN ('PENDING', 'PUBLISHED', 'FAILED')",
            name="ck_publish_requests_publication_status",
        ),
        sa.CheckConstraint(
            "(status = 'APPROVED') = (planned_dataset_id IS NOT NULL AND publication_status IS NOT NULL)",
            name="ck_publish_requests_approved",
        ),
        sa.CheckConstraint("char_length(title) BETWEEN 3 AND 300", name="ck_publish_requests_title"),
        schema=SCHEMA,
    )
    # at most one open (PENDING) or APPROVED request per output; a REJECTED output may be requested again
    op.create_index(
        "uq_publish_requests_output_open",
        "publish_requests",
        ["output_id"],
        unique=True,
        schema=SCHEMA,
        postgresql_where=sa.text("status IN ('PENDING', 'APPROVED')"),
    )
    op.create_index(
        "ix_publish_requests_project",
        "publish_requests",
        ["project_id", sa.text("created_at DESC"), sa.text("request_id DESC")],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_publish_requests_publication",
        "publish_requests",
        ["publication_attempted_at"],
        schema=SCHEMA,
        postgresql_where=sa.text("publication_status = 'PENDING'"),
    )
    op.create_table(
        "publish_approvals",
        sa.Column(
            "request_id",
            UUID(as_uuid=True),
            sa.ForeignKey(f"{SCHEMA}.publish_requests.request_id"),
            nullable=False,
        ),
        sa.Column("organization_id", UUID(as_uuid=True), nullable=False),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("kind", sa.Text, nullable=False),
        sa.Column("decided_by", UUID(as_uuid=True), nullable=True),
        sa.Column("decision", sa.Text, nullable=True),
        sa.Column("comment", sa.Text, nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("request_id", "organization_id", name="pk_publish_approvals"),
        sa.CheckConstraint("kind IN ('INPUT_OWNER', 'LEAD_ORGANIZATION')", name="ck_publish_approvals_kind"),
        sa.CheckConstraint(
            "decision IS NULL OR decision IN ('APPROVE', 'REJECT')", name="ck_publish_approvals_decision"
        ),
        sa.CheckConstraint(
            "(decision IS NULL) = (decided_by IS NULL) AND (decision IS NULL) = (decided_at IS NULL)",
            name="ck_publish_approvals_decided",
        ),
        sa.CheckConstraint(
            "decision IS DISTINCT FROM 'REJECT' OR (comment IS NOT NULL AND char_length(btrim(comment)) >= 1)",
            name="ck_publish_approvals_reject_comment",
        ),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_publish_approvals_organization",
        "publish_approvals",
        ["organization_id", "kind"],
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("publish_approvals", schema=SCHEMA)
    op.drop_table("publish_requests", schema=SCHEMA)
