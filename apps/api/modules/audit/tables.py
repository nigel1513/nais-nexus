"""audit.* tables (spec §4). audit_events is append-only: never update/delete it from code."""

from sqlalchemy import Column, DateTime, ForeignKey, Integer, MetaData, String, Table, Text, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

metadata = MetaData(schema="audit")
NOW = text("now()")

audit_events = Table(
    "audit_events",
    metadata,
    Column("audit_event_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("occurred_at", DateTime(timezone=True), nullable=False),
    Column("recorded_at", DateTime(timezone=True), nullable=False, server_default=NOW),
    Column("action", String(48), nullable=False),
    Column("result", String(8), nullable=False),
    Column("reason", Text),
    Column("actor_type", String(8), nullable=False),
    Column("actor_user_id", PG_UUID(as_uuid=True)),
    Column("actor_display_name", String(200)),
    Column("actor_organization_id", PG_UUID(as_uuid=True)),
    Column("resource_type", String(32), nullable=False),
    Column("resource_id", PG_UUID(as_uuid=True), nullable=False),
    Column("resource_owner_organization_id", PG_UUID(as_uuid=True)),
    Column("project_id", PG_UUID(as_uuid=True)),
    Column("policy_version", String(64)),
    Column("source_event_id", PG_UUID(as_uuid=True), nullable=False, unique=True),
    Column("source_event_type", String(96), nullable=False),
    Column("trace_id", String(64), nullable=False),
    Column("details", JSONB, nullable=False, server_default=text("'{}'::jsonb")),
)

notifications = Table(
    "notifications",
    metadata,
    Column("notification_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("recipient_user_id", PG_UUID(as_uuid=True), nullable=False),
    Column("type", String(32), nullable=False),
    Column("title", String(300), nullable=False),
    Column("body", Text, nullable=False, server_default=""),
    Column("link", String(500), nullable=False),
    Column("source_event_id", PG_UUID(as_uuid=True), nullable=False),
    Column("read_at", DateTime(timezone=True)),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=NOW),
)

email_deliveries = Table(
    "email_deliveries",
    metadata,
    Column("email_delivery_id", PG_UUID(as_uuid=True), primary_key=True),
    Column(
        "notification_id",
        PG_UUID(as_uuid=True),
        ForeignKey("audit.notifications.notification_id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    ),
    Column("to_address", String(320), nullable=False),
    Column("status", String(16), nullable=False, server_default="PENDING"),
    Column("attempts", Integer, nullable=False, server_default="0"),
    Column("last_error", Text),
    Column("sent_at", DateTime(timezone=True)),
    Column("next_attempt_at", DateTime(timezone=True), nullable=False, server_default=NOW),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=NOW),
)

processed_events = Table(
    "processed_events",
    metadata,
    Column("event_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("handler", Text, primary_key=True),
    Column("event_type", Text, nullable=False),
    Column("processed_at", DateTime(timezone=True), nullable=False, server_default=NOW),
)
