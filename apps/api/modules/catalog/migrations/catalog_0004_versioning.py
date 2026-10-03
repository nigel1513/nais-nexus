"""catalog lakeFS-style versioning (spec §3.3b)

Revision ID: catalog_0004
Revises: catalog_0003
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "catalog_0004"
down_revision = "catalog_0003"
branch_labels = None
depends_on = None

S = "catalog"
VERSION_FK = "catalog.dataset_versions.dataset_version_id"
LINEAGE_COLUMNS = ("base_version_id", "source_version_id", "previous_version_id")

# catalog_0001 function plus the three lineage columns in the frozen tuple.
VERSIONS_FUNCTION = """
CREATE OR REPLACE FUNCTION catalog.versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
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
        NEW.created_by, NEW.created_at, NEW.base_version_id, NEW.source_version_id,
        NEW.previous_version_id)
       IS NOT DISTINCT FROM
       (OLD.dataset_version_id, OLD.dataset_id, OLD.version_label, OLD.change_note, OLD.file_count,
        OLD.total_bytes, OLD.manifest_sha256, OLD.metadata_snapshot, OLD.published_at, OLD.published_by,
        OLD.created_by, OLD.created_at, OLD.base_version_id, OLD.source_version_id,
        OLD.previous_version_id) THEN
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

# The catalog_0001 body (no lineage columns), restored on downgrade.
_V1_FUNCTION = """
CREATE OR REPLACE FUNCTION catalog.versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
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


def upgrade() -> None:
    for col in LINEAGE_COLUMNS:
        op.add_column(
            "dataset_versions",
            sa.Column(
                col, UUID(as_uuid=True), sa.ForeignKey(VERSION_FK, name=f"fk_versions_{col}"), nullable=True
            ),
            schema=S,
        )
    op.add_column(
        "dataset_files",
        sa.Column(
            "inherited_from_file_id",
            UUID(as_uuid=True),
            sa.ForeignKey("catalog.dataset_files.file_id", name="fk_files_inherited_from"),
            nullable=True,
        ),
        schema=S,
    )
    op.alter_column("dataset_files", "upload_session_id", nullable=True, schema=S)
    # Existing rows all carry an upload session, so the check holds on populated data.
    op.create_check_constraint(
        "ck_files_origin",
        "dataset_files",
        "upload_session_id IS NOT NULL OR inherited_from_file_id IS NOT NULL",
        schema=S,
    )
    op.create_index("ix_files_object", "dataset_files", ["storage_bucket", "storage_key"], schema=S)
    op.create_index("ix_files_inherited_from", "dataset_files", ["inherited_from_file_id"], schema=S)
    _backfill_lineage()
    op.execute(VERSIONS_FUNCTION)


# Versions published before catalog_0004: previous = the version published just before in the same dataset
# (published_at, tie: id; WITHDRAWN versions keep their place). PUBLISHED rows are immutable, so the trigger is off
# for this one statement, inside the migration transaction.
BACKFILL_PREVIOUS = """
UPDATE catalog.dataset_versions v SET previous_version_id = p.prev
FROM (
  SELECT dataset_version_id,
         lag(dataset_version_id) OVER (PARTITION BY dataset_id ORDER BY published_at, dataset_version_id) AS prev
  FROM catalog.dataset_versions WHERE status IN ('PUBLISHED', 'WITHDRAWN')
) p
WHERE v.dataset_version_id = p.dataset_version_id AND p.prev IS NOT NULL AND v.previous_version_id IS NULL
"""
# Drafts created before catalog_0004 had no base: the latest PUBLISHED version published before the draft was
# created (what it was branched from in spirit); none -> NULL (stale once anything is published, see README).
BACKFILL_BASE = """
UPDATE catalog.dataset_versions d SET base_version_id = (
  SELECT p.dataset_version_id FROM catalog.dataset_versions p
  WHERE p.dataset_id = d.dataset_id AND p.status = 'PUBLISHED' AND p.published_at <= d.created_at
  ORDER BY p.published_at DESC, p.dataset_version_id DESC LIMIT 1
)
WHERE d.status = 'DRAFT' AND d.base_version_id IS NULL
"""


def _backfill_lineage() -> None:
    op.execute("ALTER TABLE catalog.dataset_versions DISABLE TRIGGER trg_versions_immutable")
    op.execute(BACKFILL_PREVIOUS)
    op.execute("ALTER TABLE catalog.dataset_versions ENABLE TRIGGER trg_versions_immutable")
    op.execute(BACKFILL_BASE)  # DRAFT rows are mutable under the trigger


def downgrade() -> None:
    # One-way once inherited rows exist: they cannot be deleted (file_previews FK, files_immutable trigger on
    # published versions) and cannot satisfy the restored NOT NULL on upload_session_id.
    bind = op.get_bind()
    inherited = bind.execute(
        sa.text("SELECT count(*) FROM catalog.dataset_files WHERE upload_session_id IS NULL")
    )
    if inherited.scalar_one():
        raise NotImplementedError(
            "catalog_0004 cannot be downgraded: inherited dataset_files rows (upload_session_id IS NULL) exist; "
            "restore from a backup taken before the upgrade instead"
        )
    op.drop_index("ix_files_inherited_from", "dataset_files", schema=S)
    op.drop_index("ix_files_object", "dataset_files", schema=S)
    op.drop_constraint("ck_files_origin", "dataset_files", schema=S)
    op.alter_column("dataset_files", "upload_session_id", nullable=False, schema=S)
    op.drop_column("dataset_files", "inherited_from_file_id", schema=S)
    op.execute(_V1_FUNCTION)  # before dropping the columns it no longer references
    for col in reversed(LINEAGE_COLUMNS):
        op.drop_column("dataset_versions", col, schema=S)
