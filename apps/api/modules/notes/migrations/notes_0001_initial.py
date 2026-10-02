"""notes initial schema: research notes, blocks, signatures, hash chains, settings, evidence (M14)

The guard triggers make the research-note rules hold for every database client, not only this module's code:
a SIGNED note never changes or disappears, a SUBMITTED note's content and hash are fixed, blocks change only while
their note is DRAFT, and signatures are append-only (removed only with a DRAFT, i.e. a rejected or deleted note).

Revision ID: notes_0001
Revises:
"""

import sqlalchemy as sa
from alembic import op
from api.platform.migration_helpers import create_processed_events
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID

revision = "notes_0001"
down_revision = None
branch_labels = None
depends_on = None

SCHEMA = "notes"
NOW = sa.text("now()")
HASH = "'^[a-f0-9]{64}$'"

NOTES_GUARD = """
CREATE FUNCTION notes.notes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'SIGNED' THEN
    RAISE EXCEPTION 'research note % is SIGNED and immutable', OLD.note_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'research note % is % and cannot be deleted', OLD.note_id, OLD.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.note_id, NEW.project_id, NEW.organization_id, NEW.recorder_id, NEW.note_date, NEW.version,
      NEW.previous_version_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.note_id, OLD.project_id, OLD.organization_id, OLD.recorder_id, OLD.note_date, OLD.version,
      OLD.previous_version_id, OLD.created_at) THEN
    RAISE EXCEPTION 'identity of research note % is immutable', OLD.note_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT ((OLD.status = 'DRAFT' AND NEW.status IN ('DRAFT', 'SUBMITTED'))
          OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('SUBMITTED', 'SIGNED', 'DRAFT'))) THEN
    RAISE EXCEPTION 'research note % cannot go from % to %', OLD.note_id, OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'SUBMITTED' AND NEW.status <> 'DRAFT'
     AND (NEW.content_hash, NEW.witness_required, NEW.witness_user_ids, NEW.submitted_at, NEW.revision)
         IS DISTINCT FROM
         (OLD.content_hash, OLD.witness_required, OLD.witness_user_ids, OLD.submitted_at, OLD.revision) THEN
    RAISE EXCEPTION 'submitted research note % is locked', OLD.note_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$
"""

BLOCKS_GUARD = """
CREATE FUNCTION notes.blocks_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
  note_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.note_id IS DISTINCT FROM OLD.note_id THEN
    RAISE EXCEPTION 'blocks cannot move between notes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    target := NEW.note_id;
  ELSE
    target := OLD.note_id;
  END IF;
  -- FOR SHARE: wait for a concurrent submit/sign (row lock) to finish, then see its committed status.
  SELECT status INTO note_status FROM notes.notes WHERE note_id = target FOR SHARE;
  IF note_status IS NOT NULL AND note_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'blocks of research note % are locked (%)', target, note_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$
"""

SIGNATURES_GUARD = """
CREATE FUNCTION notes.signatures_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  note_status text;
  note_hash text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'signatures are append-only' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT status, content_hash INTO note_status, note_hash FROM notes.notes WHERE note_id = NEW.note_id FOR SHARE;
    IF note_status IS DISTINCT FROM 'SUBMITTED' OR note_hash IS DISTINCT FROM NEW.content_hash THEN
      RAISE EXCEPTION 'only the fixed content of a SUBMITTED note can be signed'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO note_status FROM notes.notes WHERE note_id = OLD.note_id FOR SHARE;
  IF note_status IS NOT NULL AND note_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'signatures of research note % cannot be removed (%)', OLD.note_id, note_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END;
$$
"""

TRIGGERS = (
    "CREATE TRIGGER trg_notes_guard BEFORE UPDATE OR DELETE ON notes.notes "
    "FOR EACH ROW EXECUTE FUNCTION notes.notes_guard()",
    "CREATE TRIGGER trg_blocks_guard BEFORE INSERT OR UPDATE OR DELETE ON notes.blocks "
    "FOR EACH ROW EXECUTE FUNCTION notes.blocks_guard()",
    "CREATE TRIGGER trg_signatures_guard BEFORE INSERT OR UPDATE OR DELETE ON notes.signatures "
    "FOR EACH ROW EXECUTE FUNCTION notes.signatures_guard()",
)

NOTE_STATE = """
(status = 'DRAFT' AND content_hash IS NULL AND chain_seq IS NULL AND chain_hash IS NULL AND signed_at IS NULL
   AND witness_required IS NULL)
OR (status = 'SUBMITTED' AND content_hash IS NOT NULL AND chain_seq IS NULL AND chain_hash IS NULL
   AND signed_at IS NULL AND witness_required IS NOT NULL AND witness_user_ids IS NOT NULL AND submitted_at IS NOT NULL)
OR (status = 'SIGNED' AND content_hash IS NOT NULL AND chain_seq IS NOT NULL AND chain_hash IS NOT NULL
   AND signed_at IS NOT NULL AND witness_required IS NOT NULL AND witness_user_ids IS NOT NULL
   AND submitted_at IS NOT NULL)
"""


def upgrade() -> None:
    op.create_table(
        "notes",
        sa.Column("note_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("project_id", UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", UUID(as_uuid=True), nullable=False),
        sa.Column("recorder_id", UUID(as_uuid=True), nullable=False),
        sa.Column("note_date", sa.Date, nullable=False),
        sa.Column("version", sa.Integer, nullable=False),
        sa.Column(
            "previous_version_id", UUID(as_uuid=True), sa.ForeignKey("notes.notes.note_id"), nullable=True
        ),
        sa.Column("status", sa.Text, nullable=False),
        sa.Column("revision", sa.Integer, nullable=False, server_default=sa.text("1")),
        sa.Column("draft_status", sa.Text, nullable=False, server_default=sa.text("'NONE'")),
        sa.Column("draft_error", sa.Text, nullable=True),
        sa.Column("witness_required", sa.Boolean, nullable=True),
        sa.Column("witness_user_ids", ARRAY(UUID(as_uuid=True)), nullable=True),
        sa.Column("content_hash", sa.Text, nullable=True),
        sa.Column("chain_seq", sa.BigInteger, nullable=True),
        sa.Column("chain_hash", sa.Text, nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("signed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rejected_reason", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.CheckConstraint("status IN ('DRAFT', 'SUBMITTED', 'SIGNED')", name="ck_notes_status"),
        sa.CheckConstraint(
            "draft_status IN ('NONE', 'QUEUED', 'RUNNING', 'FAILED', 'DONE')", name="ck_notes_draft_status"
        ),
        sa.CheckConstraint("version >= 1 AND revision >= 1", name="ck_notes_counters"),
        sa.CheckConstraint("(version = 1) = (previous_version_id IS NULL)", name="ck_notes_previous_version"),
        sa.CheckConstraint(f"content_hash IS NULL OR content_hash ~ {HASH}", name="ck_notes_content_hash"),
        sa.CheckConstraint(f"chain_hash IS NULL OR chain_hash ~ {HASH}", name="ck_notes_chain_hash"),
        sa.CheckConstraint("chain_seq IS NULL OR chain_seq >= 1", name="ck_notes_chain_seq"),
        sa.CheckConstraint(
            "rejected_reason IS NULL OR char_length(rejected_reason) BETWEEN 1 AND 2000",
            name="ck_notes_rejected_reason",
        ),
        sa.CheckConstraint(
            "witness_user_ids IS NULL OR cardinality(witness_user_ids) <= 20", name="ck_notes_witnesses"
        ),
        sa.CheckConstraint(NOTE_STATE, name="ck_notes_state"),
        sa.UniqueConstraint(
            "project_id", "recorder_id", "note_date", "version", name="uq_notes_recorder_day_version"
        ),
        sa.UniqueConstraint("project_id", "organization_id", "chain_seq", name="uq_notes_chain_seq"),
        schema=SCHEMA,
    )
    op.create_index("ix_notes_recorder_day", "notes", ["recorder_id", "note_date"], schema=SCHEMA)
    op.create_index(
        "ix_notes_project_org_status", "notes", ["project_id", "organization_id", "status"], schema=SCHEMA
    )
    op.create_index(
        "ix_notes_witnesses", "notes", ["witness_user_ids"], schema=SCHEMA, postgresql_using="gin"
    )

    op.create_table(
        "blocks",
        sa.Column("block_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("note_id", UUID(as_uuid=True), sa.ForeignKey("notes.notes.note_id"), nullable=False),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("section", sa.Text, nullable=False),
        sa.Column("text", sa.Text, nullable=False),
        sa.Column("origin", sa.Text, nullable=False),
        sa.Column("accepted", sa.Boolean, nullable=False),
        sa.Column("evidence", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.CheckConstraint(
            "section IN ('DIRECTION', 'STEPS', 'RESULTS', 'NEXT', 'MEMO')", name="ck_blocks_section"
        ),
        sa.CheckConstraint("origin IN ('HUMAN', 'AI')", name="ck_blocks_origin"),
        sa.CheckConstraint("origin = 'AI' OR accepted", name="ck_blocks_human_accepted"),
        sa.CheckConstraint("char_length(text) BETWEEN 1 AND 4000", name="ck_blocks_text"),
        sa.CheckConstraint("position >= 0", name="ck_blocks_position"),
        sa.CheckConstraint("jsonb_typeof(evidence) = 'array'", name="ck_blocks_evidence"),
        sa.UniqueConstraint("note_id", "position", name="uq_blocks_position"),
        schema=SCHEMA,
    )

    op.create_table(
        "signatures",
        sa.Column("signature_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("note_id", UUID(as_uuid=True), sa.ForeignKey("notes.notes.note_id"), nullable=False),
        sa.Column("signer_id", UUID(as_uuid=True), nullable=False),
        sa.Column("role", sa.Text, nullable=False),
        sa.Column("signed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("content_hash", sa.Text, nullable=False),
        sa.Column("auth_time", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("role IN ('RECORDER', 'WITNESS')", name="ck_signatures_role"),
        sa.CheckConstraint(f"content_hash ~ {HASH}", name="ck_signatures_content_hash"),
        sa.UniqueConstraint("note_id", "role", name="uq_signatures_role"),
        schema=SCHEMA,
    )

    op.create_table(
        "chains",
        sa.Column("project_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("organization_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("last_seq", sa.BigInteger, nullable=False, server_default=sa.text("0")),
        sa.Column("last_chain_hash", sa.Text, nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.CheckConstraint(
            f"(last_seq = 0 AND last_chain_hash IS NULL) OR (last_seq > 0 AND last_chain_hash ~ {HASH})",
            name="ck_chains_head",
        ),
        schema=SCHEMA,
    )

    op.create_table(
        "settings",
        sa.Column("project_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("witness_required", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column(
            "witness_user_ids",
            ARRAY(UUID(as_uuid=True)),
            nullable=False,
            server_default=sa.text("'{}'::uuid[]"),
        ),
        sa.Column("updated_by", UUID(as_uuid=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.CheckConstraint("cardinality(witness_user_ids) <= 20", name="ck_settings_witnesses"),
        schema=SCHEMA,
    )

    op.create_table(
        "evidence",
        sa.Column("evidence_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("project_id", UUID(as_uuid=True), nullable=False),
        sa.Column("actor_id", UUID(as_uuid=True), nullable=False),
        sa.Column("note_date", sa.Date, nullable=False),
        sa.Column("type", sa.Text, nullable=False),
        sa.Column("ref_id", UUID(as_uuid=True), nullable=False),
        sa.Column("label", sa.Text, nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("source_event_id", UUID(as_uuid=True), nullable=True, unique=True),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_evidence_project_actor_day", "evidence", ["project_id", "actor_id", "note_date"], schema=SCHEMA
    )

    create_processed_events(SCHEMA, per_handler=True)

    for statement in (NOTES_GUARD, BLOCKS_GUARD, SIGNATURES_GUARD, *TRIGGERS):
        op.execute(statement)


def downgrade() -> None:
    op.execute("DROP TRIGGER trg_signatures_guard ON notes.signatures")
    op.execute("DROP TRIGGER trg_blocks_guard ON notes.blocks")
    op.execute("DROP TRIGGER trg_notes_guard ON notes.notes")
    op.execute("DROP FUNCTION notes.signatures_guard()")
    op.execute("DROP FUNCTION notes.blocks_guard()")
    op.execute("DROP FUNCTION notes.notes_guard()")
    for table in ("processed_events", "evidence", "settings", "chains", "signatures", "blocks", "notes"):
        op.drop_table(table, schema=SCHEMA)
