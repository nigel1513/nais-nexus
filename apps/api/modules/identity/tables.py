"""SQLAlchemy Core tables of schema identity. DDL lives in migrations/, not here."""

from sqlalchemy import Column, DateTime, MetaData, String, Table, Text
from sqlalchemy.dialects.postgresql import ARRAY, UUID

metadata = MetaData(schema="identity")

organizations = Table(
    "organizations",
    metadata,
    Column("organization_id", UUID(as_uuid=True), primary_key=True),
    Column("code", String(32), nullable=False),
    Column("name", String(200), nullable=False),
    Column("type", String(32), nullable=False),
    Column("ror_id", String(64)),
    Column("homepage_url", Text),
    Column("created_at", DateTime(timezone=True)),
    Column("updated_at", DateTime(timezone=True)),
)

users = Table(
    "users",
    metadata,
    Column("user_id", UUID(as_uuid=True), primary_key=True),
    Column("keycloak_sub", String(64), nullable=False),
    Column("email", String(320), nullable=False),
    Column("display_name", String(200), nullable=False),
    Column("status", String(16)),
    Column("platform_roles", ARRAY(Text)),
    Column("last_login_at", DateTime(timezone=True)),
    Column("created_at", DateTime(timezone=True)),
    Column("updated_at", DateTime(timezone=True)),
)

memberships = Table(
    "organization_memberships",
    metadata,
    Column("membership_id", UUID(as_uuid=True), primary_key=True),
    Column("user_id", UUID(as_uuid=True), nullable=False),
    Column("organization_id", UUID(as_uuid=True), nullable=False),
    Column("roles", ARRAY(Text)),
    Column("status", String(16)),
    Column("created_at", DateTime(timezone=True)),
    Column("updated_at", DateTime(timezone=True)),
    Column("updated_by", UUID(as_uuid=True)),
)

user_sessions = Table(
    "user_sessions",
    metadata,
    Column("session_id", String(64), primary_key=True),
    Column("user_id", UUID(as_uuid=True), nullable=False),
    Column("first_seen_at", DateTime(timezone=True)),
)
