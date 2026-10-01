"""readiness: validations, check_results, processed_events (M05 §4)

Revision ID: readiness_0001
Revises:
"""

import sqlalchemy as sa
from alembic import op
from api.platform.migration_helpers import create_processed_events
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "readiness_0001"
down_revision = None
branch_labels = None
depends_on = None

SCHEMA = "readiness"
NOW = sa.text("now()")

# The app role (nais_app) holds plain DML only and owns nothing, so it cannot TRUNCATE, ALTER or DROP TRIGGER; the
# triggers below close the DML routes: write/delete results of a terminal run, move a result between runs, delete
# or reopen a COMPLETED run.
CHECK_RESULTS_FUNCTION = f"""
CREATE FUNCTION {SCHEMA}.forbid_write_after_completion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM {SCHEMA}.validations v
             WHERE v.run_status IN ('COMPLETED','FAILED')
               AND (   (TG_OP <> 'DELETE' AND v.validation_id = NEW.validation_id)
                    OR (TG_OP <> 'INSERT' AND v.validation_id = OLD.validation_id))) THEN
    RAISE EXCEPTION 'check_results of a terminal validation are immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$
"""

VALIDATIONS_FUNCTION = f"""
CREATE FUNCTION {SCHEMA}.forbid_change_of_completed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.run_status = 'COMPLETED' THEN
    RAISE EXCEPTION 'a COMPLETED validation is immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$
"""


def upgrade() -> None:
    op.create_table(
        "validations",
        sa.Column("validation_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("dataset_version_id", UUID(as_uuid=True), nullable=False),
        sa.Column("dataset_id", UUID(as_uuid=True), nullable=False),
        sa.Column("owner_organization_id", UUID(as_uuid=True), nullable=False),
        sa.Column("profile_id", sa.Text, nullable=False),
        sa.Column("profile_version", sa.Text, nullable=False),
        sa.Column("validator_version", sa.Text, nullable=False),
        sa.Column("input_fingerprint", sa.CHAR(64), nullable=False),
        sa.Column("run_status", sa.Text, nullable=False, server_default="QUEUED"),
        sa.Column("overall_status", sa.Text, nullable=True),
        sa.Column("summary", JSONB, nullable=True),
        sa.Column("result_sha256", sa.CHAR(64), nullable=True),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("triggered_by", sa.Text, nullable=False),
        sa.Column("requested_by", UUID(as_uuid=True), nullable=True),
        sa.Column("requester_organization_id", UUID(as_uuid=True), nullable=True),
        sa.Column("attempt", sa.Integer, nullable=False, server_default="0"),
        sa.Column("correlation_id", UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "profile_id IN ('GENERIC_BASIC','TABULAR_ML_BASIC')", name="ck_validation_profile"
        ),
        sa.CheckConstraint(
            "run_status IN ('QUEUED','RUNNING','COMPLETED','FAILED')", name="ck_validation_run_status"
        ),
        sa.CheckConstraint(
            "overall_status IS NULL OR overall_status IN ('PASS','WARNING','FAIL')",
            name="ck_validation_overall",
        ),
        sa.CheckConstraint("triggered_by IN ('AUTO_ON_PUBLISH','USER')", name="ck_validation_triggered_by"),
        sa.CheckConstraint(
            "(run_status = 'COMPLETED') = (overall_status IS NOT NULL)", name="ck_overall_iff_completed"
        ),
        sa.CheckConstraint(
            "run_status <> 'COMPLETED' OR (overall_status IS NOT NULL AND result_sha256 IS NOT NULL "
            "AND completed_at IS NOT NULL)",
            name="ck_completed",
        ),
        sa.CheckConstraint("run_status <> 'FAILED' OR error IS NOT NULL", name="ck_failed"),
        schema=SCHEMA,
    )
    op.create_index(
        "uq_validation_inflight",
        "validations",
        ["dataset_version_id", "profile_id"],
        unique=True,
        schema=SCHEMA,
        postgresql_where=sa.text("run_status IN ('QUEUED','RUNNING')"),
    )
    op.create_index(
        "uq_validation_reuse",
        "validations",
        ["dataset_version_id", "profile_id", "input_fingerprint"],
        unique=True,
        schema=SCHEMA,
        postgresql_where=sa.text("run_status = 'COMPLETED'"),
    )
    op.create_index(
        "ix_validation_latest",
        "validations",
        ["dataset_version_id", "profile_id", sa.text("created_at DESC")],
        schema=SCHEMA,
    )
    op.create_table(
        "check_results",
        sa.Column(
            "validation_id",
            UUID(as_uuid=True),
            sa.ForeignKey(f"{SCHEMA}.validations.validation_id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("check_id", sa.Text, primary_key=True),
        sa.Column("ordinal", sa.SmallInteger, nullable=False),
        sa.Column("severity", sa.Text, nullable=False),
        sa.Column("status", sa.Text, nullable=False),
        sa.Column("message", sa.Text, nullable=False),
        sa.Column("evidence", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.CheckConstraint("severity IN ('REQUIRED','RECOMMENDED')", name="ck_check_severity"),
        sa.CheckConstraint("status IN ('PASS','WARNING','FAIL','NOT_APPLICABLE')", name="ck_check_status"),
        # the app bounds canonical JSON to 64 KiB (engine.canonical.bound_evidence); jsonb::text adds a space after
        # every ':' and ',' so the database backstop allows twice that
        sa.CheckConstraint("octet_length(evidence::text) <= 131072", name="ck_check_evidence_size"),
        schema=SCHEMA,
    )
    op.execute(CHECK_RESULTS_FUNCTION)
    op.execute(
        f"CREATE TRIGGER trg_check_results_immutable BEFORE INSERT OR UPDATE OR DELETE ON {SCHEMA}.check_results "
        f"FOR EACH ROW EXECUTE FUNCTION {SCHEMA}.forbid_write_after_completion()"
    )
    op.execute(VALIDATIONS_FUNCTION)
    op.execute(
        f"CREATE TRIGGER trg_validations_completed_immutable BEFORE UPDATE OR DELETE ON {SCHEMA}.validations "
        f"FOR EACH ROW EXECUTE FUNCTION {SCHEMA}.forbid_change_of_completed()"
    )
    create_processed_events(SCHEMA, per_handler=True)


def downgrade() -> None:
    op.drop_table("processed_events", schema=SCHEMA)
    op.drop_table("check_results", schema=SCHEMA)
    op.drop_table("validations", schema=SCHEMA)
    op.execute(f"DROP FUNCTION {SCHEMA}.forbid_write_after_completion()")
    op.execute(f"DROP FUNCTION {SCHEMA}.forbid_change_of_completed()")
