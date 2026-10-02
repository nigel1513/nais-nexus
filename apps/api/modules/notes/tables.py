"""notes schema (SQLAlchemy Core). migrations/ owns the DDL (with the guard triggers); keep both in step."""

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    MetaData,
    Table,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

SCHEMA = "notes"
NOW = text("now()")

metadata = MetaData(schema=SCHEMA)

# One row per note version. organization_id is the recorder's organization at creation and never changes.
# witness_required / witness_user_ids: the snapshot taken at submit (NULL while DRAFT). chain_seq / chain_hash: the
# note's place in its project x organization chain, set when SIGNED.
notes = Table(
    "notes",
    metadata,
    Column("note_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("project_id", PG_UUID(as_uuid=True), nullable=False),
    Column("organization_id", PG_UUID(as_uuid=True), nullable=False),
    Column("recorder_id", PG_UUID(as_uuid=True), nullable=False),
    Column("note_date", Date, nullable=False),
    Column("version", Integer, nullable=False),
    Column("previous_version_id", PG_UUID(as_uuid=True), ForeignKey("notes.notes.note_id")),
    Column("status", Text, nullable=False),
    Column("revision", Integer, nullable=False, server_default=text("1")),
    Column("draft_status", Text, nullable=False, server_default=text("'NONE'")),
    Column("draft_error", Text),
    Column("draft_requested_at", DateTime(timezone=True)),  # last draftNote / scheduled draft (rate limit)
    Column("witness_required", Boolean),
    Column("witness_user_ids", ARRAY(PG_UUID(as_uuid=True))),
    Column("content_hash", Text),
    Column("chain_seq", BigInteger),
    Column("chain_hash", Text),
    Column("submitted_at", DateTime(timezone=True)),
    Column("signed_at", DateTime(timezone=True)),
    Column("rejected_reason", Text),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=NOW),
    Column("updated_at", DateTime(timezone=True), nullable=False, server_default=NOW),
)

# Blocks in order (position 0..n-1). evidence: list of {type, ref_id, label, at} (labels only, never data values).
blocks = Table(
    "blocks",
    metadata,
    Column("block_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("note_id", PG_UUID(as_uuid=True), ForeignKey("notes.notes.note_id"), nullable=False),
    Column("position", Integer, nullable=False),
    Column("section", Text, nullable=False),
    Column("text", Text, nullable=False),
    Column("origin", Text, nullable=False),
    Column("accepted", Boolean, nullable=False),
    Column("evidence", JSONB, nullable=False, server_default=text("'[]'::jsonb")),
)

# One RECORDER and at most one WITNESS signature per note; append-only (guard trigger).
signatures = Table(
    "signatures",
    metadata,
    Column("signature_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("note_id", PG_UUID(as_uuid=True), ForeignKey("notes.notes.note_id"), nullable=False),
    Column("signer_id", PG_UUID(as_uuid=True), nullable=False),
    Column("role", Text, nullable=False),
    Column("signed_at", DateTime(timezone=True), nullable=False),
    Column("content_hash", Text, nullable=False),
    Column("auth_time", DateTime(timezone=True), nullable=False),
)

# Head of each project x organization chain; its row lock serializes the SIGNED transitions of the chain.
chains = Table(
    "chains",
    metadata,
    Column("project_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("organization_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("last_seq", BigInteger, nullable=False, server_default=text("0")),
    Column("last_chain_hash", Text),
    Column("updated_at", DateTime(timezone=True), nullable=False, server_default=NOW),
)

settings = Table(
    "settings",
    metadata,
    Column("project_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("witness_required", Boolean, nullable=False, server_default=text("false")),
    Column(
        "witness_user_ids",
        ARRAY(PG_UUID(as_uuid=True)),
        nullable=False,
        server_default=text("'{}'::uuid[]"),
    ),
    Column("updated_by", PG_UUID(as_uuid=True)),
    Column("updated_at", DateTime(timezone=True), nullable=False, server_default=NOW),
)

# Day activity per project x actor (Asia/Seoul note_date) collected from other modules' events for drafting (Task 10).
evidence = Table(
    "evidence",
    metadata,
    Column("evidence_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("project_id", PG_UUID(as_uuid=True), nullable=False),
    Column("actor_id", PG_UUID(as_uuid=True), nullable=False),
    Column("note_date", Date, nullable=False),
    Column("type", Text, nullable=False),
    Column("ref_id", PG_UUID(as_uuid=True), nullable=False),
    Column("label", Text, nullable=False),
    Column("at", DateTime(timezone=True), nullable=False),
    Column("payload", JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    Column("source_event_id", PG_UUID(as_uuid=True), unique=True),
)

processed_events = Table(
    "processed_events",
    metadata,
    Column("event_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("handler", Text, primary_key=True),
    Column("event_type", Text, nullable=False),
    Column("processed_at", DateTime(timezone=True), nullable=False, server_default=NOW),
)
