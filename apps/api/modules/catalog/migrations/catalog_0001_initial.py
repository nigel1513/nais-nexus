"""catalog initial schema (M03 §4)

Revision ID: catalog_0001
Revises:
"""

from typing import Any

import sqlalchemy as sa
from alembic import op
from api.platform.migration_helpers import create_processed_events
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID

revision = "catalog_0001"
down_revision = None
branch_labels = None
depends_on = None

S = "catalog"
NOW = sa.text("now()")
PURPOSES = (
    "ARRAY['ACADEMIC_RESEARCH','AI_TRAINING','COMMERCIAL_RESEARCH','EDUCATION','PUBLIC_INTEREST']::text[]"
)
FAILURES = "('OBJECT_MISSING','SIZE_MISMATCH','CHECKSUM_MISMATCH','TYPE_MISMATCH','ARCHIVE_UNSAFE','MALWARE_DETECTED','SESSION_EXPIRED')"


def _uuid(name: str, *args: Any, **kw: Any) -> sa.Column[Any]:
    return sa.Column(name, UUID(as_uuid=True), *args, **kw)


def _ts(name: str, *, nullable: bool = False, now: bool = False) -> sa.Column[Any]:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable, server_default=NOW if now else None)


VERSIONS_FUNCTION = """
CREATE FUNCTION catalog.versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'dataset version % is % and immutable', OLD.dataset_version_id, OLD.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'PUBLISHED' THEN
    IF NEW.status = 'WITHDRAWN' AND
       (NEW.dataset_version_id, NEW.dataset_id, NEW.version_label, NEW.change_note, NEW.file_count,
        NEW.total_bytes, NEW.manifest_sha256, NEW.metadata_snapshot, NEW.published_at, NEW.published_by,
        NEW.created_by, NEW.created_at)
       IS NOT DISTINCT FROM
       (OLD.dataset_version_id, OLD.dataset_id, OLD.version_label, OLD.change_note, OLD.file_count,
        OLD.total_bytes, OLD.manifest_sha256, OLD.metadata_snapshot, OLD.published_at, OLD.published_by,
        OLD.created_by, OLD.created_at) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'dataset version % is PUBLISHED and immutable', OLD.dataset_version_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'WITHDRAWN' THEN
    RAISE EXCEPTION 'dataset version % is WITHDRAWN and immutable', OLD.dataset_version_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$
"""

VERSIONS_TRIGGER = """
CREATE TRIGGER trg_versions_immutable BEFORE UPDATE OR DELETE ON catalog.dataset_versions
FOR EACH ROW EXECUTE FUNCTION catalog.versions_immutable()
"""

FILES_FUNCTION = """
CREATE FUNCTION catalog.files_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  version_status text;
  target uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    target = NEW.dataset_version_id;
  ELSE
    target = OLD.dataset_version_id;
  END IF;
  SELECT status INTO version_status FROM catalog.dataset_versions WHERE dataset_version_id = target;
  IF version_status IS NOT NULL AND version_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'files of dataset version % are immutable (%)', target, version_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$
"""

FILES_TRIGGER = """
CREATE TRIGGER trg_files_immutable BEFORE INSERT OR UPDATE OR DELETE ON catalog.dataset_files
FOR EACH ROW EXECUTE FUNCTION catalog.files_immutable()
"""


def upgrade() -> None:
    op.create_table(
        "datasets",
        _uuid("dataset_id", primary_key=True),
        _uuid("owner_organization_id", nullable=False),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("keywords", ARRAY(sa.Text), nullable=False, server_default=sa.text("'{}'::text[]")),
        sa.Column("domain", sa.Text),
        sa.Column("access_level", sa.Text, nullable=False),
        sa.Column("license", sa.Text, nullable=False),
        sa.Column("usage_policy", sa.Text),
        sa.Column("allowed_purposes", ARRAY(sa.Text), nullable=False),
        sa.Column("approval_required", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("max_grant_days", sa.Integer, nullable=False, server_default="180"),
        sa.Column("contact_email", sa.Text),
        sa.Column("provenance", sa.Text),
        sa.Column("status", sa.Text, nullable=False, server_default="ACTIVE"),
        _uuid("created_by", nullable=False),
        _ts("created_at", now=True),
        _ts("updated_at", now=True),
        sa.Column("row_version", sa.Integer, nullable=False, server_default="1"),
        sa.CheckConstraint("char_length(title) BETWEEN 3 AND 300", name="ck_datasets_title"),
        sa.CheckConstraint("char_length(description) <= 20000", name="ck_datasets_description"),
        sa.CheckConstraint("cardinality(keywords) <= 30", name="ck_datasets_keywords"),
        sa.CheckConstraint(
            "access_level IN ('PUBLIC','INTERNAL','CONTROLLED','SENSITIVE')", name="ck_datasets_access_level"
        ),
        sa.CheckConstraint("char_length(license) >= 1", name="ck_datasets_license"),
        sa.CheckConstraint(
            "usage_policy IS NULL OR char_length(usage_policy) <= 10000", name="ck_datasets_usage_policy"
        ),
        sa.CheckConstraint(
            f"cardinality(allowed_purposes) >= 1 AND allowed_purposes <@ {PURPOSES}",
            name="ck_datasets_purposes",
        ),
        sa.CheckConstraint(
            "approval_required OR access_level NOT IN ('CONTROLLED','SENSITIVE')", name="ck_datasets_approval"
        ),
        sa.CheckConstraint("max_grant_days BETWEEN 1 AND 365", name="ck_datasets_max_grant_days"),
        sa.CheckConstraint(
            "provenance IS NULL OR char_length(provenance) <= 10000", name="ck_datasets_provenance"
        ),
        sa.CheckConstraint("status IN ('ACTIVE','WITHDRAWN')", name="ck_datasets_status"),
        sa.CheckConstraint(
            "access_level <> 'SENSITIVE' OR max_grant_days <= 30", name="ck_datasets_sensitive_max_days"
        ),
        schema=S,
    )
    op.create_index("ix_datasets_owner_org", "datasets", ["owner_organization_id"], schema=S)
    op.create_index("ix_datasets_status", "datasets", ["status"], schema=S)

    op.create_table(
        "dataset_versions",
        _uuid("dataset_version_id", primary_key=True),
        _uuid("dataset_id", sa.ForeignKey("catalog.datasets.dataset_id"), nullable=False),
        sa.Column("version_label", sa.Text, nullable=False),
        sa.Column("status", sa.Text, nullable=False, server_default="DRAFT"),
        sa.Column("change_note", sa.Text),
        sa.Column("file_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("total_bytes", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("manifest_sha256", sa.CHAR(64)),
        sa.Column("metadata_snapshot", JSONB),
        _ts("published_at", nullable=True),
        _uuid("published_by"),
        _uuid("created_by", nullable=False),
        _ts("created_at", now=True),
        _ts("updated_at", now=True),
        sa.UniqueConstraint("dataset_id", "version_label", name="uq_versions_label"),
        sa.CheckConstraint(r"version_label ~ '^[A-Za-z0-9._-]{1,32}$'", name="ck_versions_label"),
        sa.CheckConstraint("status IN ('DRAFT','PUBLISHED','WITHDRAWN')", name="ck_versions_status"),
        sa.CheckConstraint(
            "change_note IS NULL OR char_length(change_note) <= 2000", name="ck_versions_note"
        ),
        sa.CheckConstraint("file_count >= 0 AND total_bytes >= 0", name="ck_versions_counts"),
        sa.CheckConstraint(
            "status = 'DRAFT' OR (manifest_sha256 IS NOT NULL AND published_at IS NOT NULL"
            " AND metadata_snapshot IS NOT NULL)",
            name="ck_versions_published",
        ),
        schema=S,
    )
    op.create_index(
        "ix_versions_dataset", "dataset_versions", ["dataset_id", sa.text("created_at DESC")], schema=S
    )

    op.create_table(
        "upload_sessions",
        _uuid("upload_session_id", primary_key=True),
        _uuid(
            "dataset_version_id", sa.ForeignKey("catalog.dataset_versions.dataset_version_id"), nullable=False
        ),
        sa.Column("status", sa.Text, nullable=False, server_default="OPEN"),
        _uuid("created_by", nullable=False),
        _ts("expires_at"),
        _ts("completed_at", nullable=True),
        _ts("created_at", now=True),
        sa.CheckConstraint("status IN ('OPEN','COMPLETED','EXPIRED')", name="ck_sessions_status"),
        schema=S,
    )
    op.create_index(
        "ix_sessions_open",
        "upload_sessions",
        ["expires_at"],
        schema=S,
        postgresql_where=sa.text("status = 'OPEN'"),
    )

    op.create_table(
        "dataset_files",
        _uuid("file_id", primary_key=True),
        _uuid(
            "dataset_version_id", sa.ForeignKey("catalog.dataset_versions.dataset_version_id"), nullable=False
        ),
        _uuid(
            "upload_session_id", sa.ForeignKey("catalog.upload_sessions.upload_session_id"), nullable=False
        ),
        sa.Column("path", sa.Text, nullable=False),
        sa.Column("size_bytes", sa.BigInteger, nullable=False),
        sa.Column("sha256", sa.CHAR(64), nullable=False),
        sa.Column("media_type", sa.Text, nullable=False),
        sa.Column("storage_bucket", sa.Text, nullable=False),
        sa.Column("storage_key", sa.Text, nullable=False),
        sa.Column("multipart_upload_id", sa.Text),
        sa.Column("part_size_bytes", sa.BigInteger),
        sa.Column("status", sa.Text, nullable=False, server_default="PENDING"),
        sa.Column("failure_code", sa.Text),
        sa.Column("scan_status", sa.Text, nullable=False, server_default="SKIPPED"),
        _ts("verified_at", nullable=True),
        _ts("created_at", now=True),
        _ts("updated_at", now=True),
        sa.UniqueConstraint("dataset_version_id", "path", name="uq_files_path"),
        sa.CheckConstraint(
            r"char_length(path) BETWEEN 1 AND 512 AND path ~ '^[A-Za-z0-9._/-]+$'"
            r" AND path !~ '(^/|//|/$|(^|/)\.\.?(/|$))'",
            name="ck_files_path",
        ),
        sa.CheckConstraint("size_bytes BETWEEN 1 AND 53687091200", name="ck_files_size"),
        sa.CheckConstraint("sha256 ~ '^[a-f0-9]{64}$'", name="ck_files_sha256"),
        sa.CheckConstraint("status IN ('PENDING','UPLOADED','VERIFIED','FAILED')", name="ck_files_status"),
        sa.CheckConstraint(
            f"failure_code IS NULL OR failure_code IN {FAILURES}", name="ck_files_failure_code"
        ),
        sa.CheckConstraint("scan_status IN ('CLEAN','INFECTED','SKIPPED')", name="ck_files_scan_status"),
        schema=S,
    )
    op.create_index("ix_files_session", "dataset_files", ["upload_session_id"], schema=S)
    op.create_index(
        "ix_files_status",
        "dataset_files",
        ["status"],
        schema=S,
        postgresql_where=sa.text("status IN ('PENDING','UPLOADED')"),
    )

    op.create_table(
        "readiness_summaries",
        _uuid("dataset_version_id", primary_key=True),
        sa.Column("profile_id", sa.Text, primary_key=True),
        _uuid("dataset_id", nullable=False),
        _uuid("validation_id", nullable=False),
        sa.Column("run_status", sa.Text, nullable=False),
        sa.Column("overall_status", sa.Text),
        _ts("completed_at"),
        _uuid("source_event_id", nullable=False),
        sa.CheckConstraint("run_status IN ('COMPLETED','FAILED')", name="ck_readiness_run_status"),
        sa.CheckConstraint(
            "overall_status IS NULL OR overall_status IN ('PASS','WARNING','FAIL')",
            name="ck_readiness_overall",
        ),
        schema=S,
    )

    op.create_table(
        "index_queue",
        _uuid("dataset_id", primary_key=True),
        _ts("enqueued_at", now=True),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        _ts("next_attempt_at", now=True),
        schema=S,
    )
    op.create_index("ix_index_queue_due", "index_queue", ["next_attempt_at"], schema=S)

    create_processed_events(S, per_handler=True)

    for statement in (VERSIONS_FUNCTION, VERSIONS_TRIGGER, FILES_FUNCTION, FILES_TRIGGER):
        op.execute(statement)


def downgrade() -> None:
    for table in (
        "processed_events",
        "index_queue",
        "readiness_summaries",
        "dataset_files",
        "upload_sessions",
        "dataset_versions",
        "datasets",
    ):
        op.drop_table(table, schema=S)
    op.execute("DROP FUNCTION IF EXISTS catalog.files_immutable()")
    op.execute("DROP FUNCTION IF EXISTS catalog.versions_immutable()")
