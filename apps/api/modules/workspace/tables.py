"""workspace schema (SQLAlchemy Core). Migrations in migrations/ own the DDL; keep both in step."""

from sqlalchemy import Column, DateTime, MetaData, Table, Text, text
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

SCHEMA = "workspace"
NOW = text("now()")

metadata = MetaData(schema=SCHEMA)

# A dataset version pinned into a project. One live row per (project, dataset); removal is a soft delete.
inputs = Table(
    "inputs",
    metadata,
    Column("input_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("project_id", PG_UUID(as_uuid=True), nullable=False),
    Column("dataset_id", PG_UUID(as_uuid=True), nullable=False),
    Column("dataset_version_id", PG_UUID(as_uuid=True), nullable=False),
    Column("added_by", PG_UUID(as_uuid=True), nullable=False),
    Column("added_at", DateTime(timezone=True), nullable=False, server_default=NOW),
    Column("note", Text),
    Column("removed_at", DateTime(timezone=True)),
)

processed_events = Table(
    "processed_events",
    metadata,
    Column("event_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("handler", Text, primary_key=True),
    Column("event_type", Text, nullable=False),
    Column("processed_at", DateTime(timezone=True), nullable=False, server_default=NOW),
)
