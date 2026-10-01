"""SQLAlchemy Core view of the catalog schema (DDL lives in migrations/)."""

from typing import Any

from sqlalchemy import BigInteger, Boolean, Column, DateTime, Integer, MetaData, Table, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID

metadata = MetaData(schema="catalog")


def _uuid(name: str, primary_key: bool = False) -> Column[Any]:
    return Column(name, UUID(as_uuid=True), primary_key=primary_key)


def _ts(name: str) -> Column[Any]:
    return Column(name, DateTime(timezone=True))


datasets = Table(
    "datasets",
    metadata,
    _uuid("dataset_id", primary_key=True),
    _uuid("owner_organization_id"),
    Column("title", Text),
    Column("description", Text),
    Column("keywords", ARRAY(Text)),
    Column("domain", Text),
    Column("access_level", Text),
    Column("license", Text),
    Column("usage_policy", Text),
    Column("allowed_purposes", ARRAY(Text)),
    Column("approval_required", Boolean),
    Column("max_grant_days", Integer),
    Column("contact_email", Text),
    Column("provenance", Text),
    Column("status", Text),
    _uuid("created_by"),
    _ts("created_at"),
    _ts("updated_at"),
    Column("row_version", Integer),
)

dataset_versions = Table(
    "dataset_versions",
    metadata,
    _uuid("dataset_version_id", primary_key=True),
    _uuid("dataset_id"),
    Column("version_label", Text),
    Column("status", Text),
    Column("change_note", Text),
    Column("file_count", Integer),
    Column("total_bytes", BigInteger),
    Column("manifest_sha256", Text),
    Column("metadata_snapshot", JSONB),
    _ts("published_at"),
    _uuid("published_by"),
    _uuid("created_by"),
    _ts("created_at"),
    _ts("updated_at"),
)

upload_sessions = Table(
    "upload_sessions",
    metadata,
    _uuid("upload_session_id", primary_key=True),
    _uuid("dataset_version_id"),
    Column("status", Text),
    _uuid("created_by"),
    _ts("expires_at"),
    _ts("completed_at"),
    _ts("created_at"),
)

dataset_files = Table(
    "dataset_files",
    metadata,
    _uuid("file_id", primary_key=True),
    _uuid("dataset_version_id"),
    _uuid("upload_session_id"),
    Column("path", Text),
    Column("size_bytes", BigInteger),
    Column("sha256", Text),
    Column("media_type", Text),
    Column("storage_bucket", Text),
    Column("storage_key", Text),
    Column("multipart_upload_id", Text),
    Column("part_size_bytes", BigInteger),
    Column("status", Text),
    Column("failure_code", Text),
    Column("scan_status", Text),
    _ts("verified_at"),
    _ts("created_at"),
    _ts("updated_at"),
)

readiness_summaries = Table(
    "readiness_summaries",
    metadata,
    _uuid("dataset_version_id", primary_key=True),
    Column("profile_id", Text, primary_key=True),
    _uuid("dataset_id"),
    _uuid("validation_id"),
    Column("run_status", Text),
    Column("overall_status", Text),
    _ts("completed_at"),
    _uuid("source_event_id"),
)

index_queue = Table(
    "index_queue",
    metadata,
    _uuid("dataset_id", primary_key=True),
    _ts("enqueued_at"),
    Column("attempts", Integer),
    _ts("next_attempt_at"),
)
