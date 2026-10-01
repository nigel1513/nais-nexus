"""audit tables

Revision ID: audit_0001
Revises:
"""

import sqlalchemy as sa
from alembic import op
from api.platform.migration_helpers import create_processed_events
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "audit_0001"
down_revision = None
branch_labels = None
depends_on = None

SCHEMA = "audit"
NOW = sa.text("now()")

# Frozen copies of openapi enums at the time of this revision (migrations must not drift with the contract).
ACTIONS = (
    "LOGIN",
    "USER_CREATED",
    "ORGANIZATION_CREATED",
    "ADMIN_ROLE_CHANGED",
    "PROJECT_CREATED",
    "PROJECT_ARCHIVED",
    "PROJECT_MEMBER_ADDED",
    "PROJECT_MEMBER_REMOVED",
    "PROJECT_MEMBER_ROLE_CHANGED",
    "DATASET_CREATED",
    "DATASET_VERSION_PUBLISHED",
    "POLICY_CHANGED",
    "ACCESS_REQUESTED",
    "ACCESS_REVIEW_STARTED",
    "ACCESS_APPROVED",
    "ACCESS_REJECTED",
    "ACCESS_CHANGES_REQUESTED",
    "ACCESS_WITHDRAWN",
    "ACCESS_REVOKED",
    "ACCESS_EXPIRED",
    "FILE_DOWNLOADED",
    "DOWNLOAD_DENIED",
    "READINESS_VALIDATION_COMPLETED",
)
RESOURCE_TYPES = (
    "USER",
    "ORGANIZATION",
    "MEMBERSHIP",
    "PROJECT",
    "PROJECT_MEMBER",
    "DATASET",
    "DATASET_VERSION",
    "DATASET_FILE",
    "ACCESS_REQUEST",
    "ACCESS_GRANT",
    "READINESS_VALIDATION",
)
NOTIFICATION_TYPES = (
    "PROJECT_INVITATION",
    "ACCESS_SUBMITTED",
    "ACCESS_APPROVED",
    "ACCESS_REJECTED",
    "ACCESS_CHANGES_REQUESTED",
    "ACCESS_EXPIRING",
    "ACCESS_REVOKED",
    "DATASET_PUBLISHED",
)


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def upgrade() -> None:
    op.create_table(
        "audit_events",
        sa.Column("audit_event_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("action", sa.String(48), nullable=False),
        sa.Column("result", sa.String(8), nullable=False),
        sa.Column("reason", sa.Text, nullable=True),
        sa.Column("actor_type", sa.String(8), nullable=False),
        sa.Column("actor_user_id", UUID(as_uuid=True), nullable=True),
        sa.Column("actor_display_name", sa.String(200), nullable=True),
        sa.Column("actor_organization_id", UUID(as_uuid=True), nullable=True),
        sa.Column("resource_type", sa.String(32), nullable=False),
        sa.Column("resource_id", UUID(as_uuid=True), nullable=False),
        sa.Column("resource_owner_organization_id", UUID(as_uuid=True), nullable=True),
        sa.Column("project_id", UUID(as_uuid=True), nullable=True),
        sa.Column("policy_version", sa.String(64), nullable=True),
        sa.Column("source_event_id", UUID(as_uuid=True), nullable=False),
        sa.Column("source_event_type", sa.String(96), nullable=False),
        sa.Column("trace_id", sa.String(64), nullable=False),
        sa.Column("details", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.UniqueConstraint("source_event_id", name="uq_audit_events_source_event_id"),
        sa.CheckConstraint(_in("action", ACTIONS), name="ck_audit_events_action"),
        sa.CheckConstraint(_in("result", ("SUCCESS", "DENIED")), name="ck_audit_events_result"),
        sa.CheckConstraint(_in("actor_type", ("USER", "SYSTEM")), name="ck_audit_events_actor_type"),
        sa.CheckConstraint(_in("resource_type", RESOURCE_TYPES), name="ck_audit_events_resource_type"),
        schema=SCHEMA,
    )
    for name, columns in (
        ("ix_audit_occurred", ["occurred_at DESC", "audit_event_id DESC"]),
        ("ix_audit_actor", ["actor_user_id", "occurred_at DESC"]),
        ("ix_audit_actor_org", ["actor_organization_id", "occurred_at DESC"]),
        ("ix_audit_owner_org", ["resource_owner_organization_id", "occurred_at DESC"]),
        ("ix_audit_project", ["project_id", "occurred_at DESC"]),
        ("ix_audit_resource", ["resource_type", "resource_id"]),
        ("ix_audit_action", ["action", "occurred_at DESC"]),
    ):
        op.create_index(name, "audit_events", [sa.text(c) for c in columns], schema=SCHEMA)

    op.create_table(
        "notifications",
        sa.Column("notification_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("recipient_user_id", UUID(as_uuid=True), nullable=False),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("title", sa.String(300), nullable=False),
        sa.Column("body", sa.Text, nullable=False, server_default=""),
        sa.Column("link", sa.String(500), nullable=False),
        sa.Column("source_event_id", UUID(as_uuid=True), nullable=False),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.UniqueConstraint("source_event_id", "recipient_user_id", name="uq_notifications_source_recipient"),
        sa.CheckConstraint(_in("type", NOTIFICATION_TYPES), name="ck_notifications_type"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_notifications_recipient",
        "notifications",
        [sa.text("recipient_user_id"), sa.text("created_at DESC")],
        schema=SCHEMA,
    )
    op.create_index(
        "ix_notifications_unread",
        "notifications",
        ["recipient_user_id"],
        schema=SCHEMA,
        postgresql_where=sa.text("read_at IS NULL"),
    )

    op.create_table(
        "email_deliveries",
        sa.Column("email_delivery_id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "notification_id",
            UUID(as_uuid=True),
            sa.ForeignKey("audit.notifications.notification_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("to_address", sa.String(320), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="PENDING"),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("last_error", sa.Text, nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.UniqueConstraint("notification_id", name="uq_email_deliveries_notification"),
        sa.CheckConstraint(_in("status", ("PENDING", "SENT", "FAILED")), name="ck_email_deliveries_status"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_email_deliveries_due",
        "email_deliveries",
        ["next_attempt_at"],
        schema=SCHEMA,
        postgresql_where=sa.text("status = 'PENDING'"),
    )

    create_processed_events(SCHEMA, per_handler=True)


def downgrade() -> None:
    op.drop_table("processed_events", schema=SCHEMA)
    op.drop_table("email_deliveries", schema=SCHEMA)
    op.drop_table("notifications", schema=SCHEMA)
    op.drop_table("audit_events", schema=SCHEMA)
