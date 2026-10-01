"""SQLAlchemy Core view of the project schema (source of truth: migrations/)."""

from sqlalchemy import Column, Date, DateTime, ForeignKey, Integer, MetaData, String, Table, Text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

metadata = MetaData(schema="project")

projects = Table(
    "projects",
    metadata,
    Column("project_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("name", String(200), nullable=False),
    Column("description", Text, nullable=False),
    Column("visibility", String(16), nullable=False),
    Column("status", String(16), nullable=False),
    Column("lead_organization_id", PG_UUID(as_uuid=True), nullable=False),
    Column("keywords", ARRAY(Text), nullable=False),
    Column("start_date", Date, nullable=True),
    Column("end_date", Date, nullable=True),
    Column("created_by", PG_UUID(as_uuid=True), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    Column("archived_at", DateTime(timezone=True), nullable=True),
)

project_members = Table(
    "project_members",
    metadata,
    Column("project_member_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("project_id", PG_UUID(as_uuid=True), ForeignKey("project.projects.project_id"), nullable=False),
    Column("user_id", PG_UUID(as_uuid=True), nullable=False),
    Column("organization_id", PG_UUID(as_uuid=True), nullable=False),
    Column("role", String(16), nullable=False),
    Column("status", String(16), nullable=False),
    Column("joined_at", DateTime(timezone=True), nullable=False),
    Column("added_by", PG_UUID(as_uuid=True), nullable=False),
    Column("removed_at", DateTime(timezone=True), nullable=True),
    Column("removed_by", PG_UUID(as_uuid=True), nullable=True),
    Column("removal_reason", Text, nullable=True),
)

project_organizations = Table(
    "project_organizations",
    metadata,
    Column("project_id", PG_UUID(as_uuid=True), ForeignKey("project.projects.project_id"), primary_key=True),
    Column("organization_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("role", String(8), nullable=False),
    Column("active_member_count", Integer, nullable=False),
)
