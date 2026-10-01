"""SQLAlchemy Core tables for readiness.* (DDL lives in migrations/0001_readiness_initial.py)."""

from sqlalchemy import CHAR, Column, DateTime, ForeignKey, Integer, MetaData, SmallInteger, Table, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

metadata = MetaData(schema="readiness")

validations = Table(
    "validations",
    metadata,
    Column("validation_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("dataset_version_id", PG_UUID(as_uuid=True), nullable=False),
    Column("dataset_id", PG_UUID(as_uuid=True), nullable=False),
    Column("owner_organization_id", PG_UUID(as_uuid=True), nullable=False),
    Column("profile_id", Text, nullable=False),
    Column("profile_version", Text, nullable=False),
    Column("validator_version", Text, nullable=False),
    Column("input_fingerprint", CHAR(64), nullable=False),
    Column("run_status", Text, nullable=False),
    Column("overall_status", Text),
    Column("summary", JSONB),
    Column("result_sha256", CHAR(64)),
    Column("error", Text),
    Column("triggered_by", Text, nullable=False),
    Column("requested_by", PG_UUID(as_uuid=True)),
    Column("requester_organization_id", PG_UUID(as_uuid=True)),
    Column("attempt", Integer, nullable=False),
    Column("correlation_id", PG_UUID(as_uuid=True), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("started_at", DateTime(timezone=True)),
    Column("completed_at", DateTime(timezone=True)),
)

check_results = Table(
    "check_results",
    metadata,
    Column("validation_id", PG_UUID(as_uuid=True), ForeignKey(validations.c.validation_id), primary_key=True),
    Column("check_id", Text, primary_key=True),
    Column("ordinal", SmallInteger, nullable=False),
    Column("severity", Text, nullable=False),
    Column("status", Text, nullable=False),
    Column("message", Text, nullable=False),
    Column("evidence", JSONB, nullable=False),
)
