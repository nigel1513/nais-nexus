"""workspace schema (SQLAlchemy Core). Migrations in migrations/ own the DDL; keep both in step."""

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    MetaData,
    PrimaryKeyConstraint,
    Table,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
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

# Discussions (spec §5.6). project_id is the owning project for PROJECT/OUTPUT/RECIPE threads and NULL for DATASET
# threads; owner_organization_id is the dataset owner for DATASET threads (event payload, steward rule).
threads = Table(
    "threads",
    metadata,
    Column("thread_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("scope", Text, nullable=False),
    Column("target_id", PG_UUID(as_uuid=True), nullable=False),
    Column("project_id", PG_UUID(as_uuid=True)),
    Column("owner_organization_id", PG_UUID(as_uuid=True)),
    Column("title", Text, nullable=False),
    Column("created_by", PG_UUID(as_uuid=True), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=NOW),
    Column("resolved", Boolean, nullable=False, server_default=text("false")),
    Column("comment_count", Integer, nullable=False),
    Column("last_comment_at", DateTime(timezone=True), nullable=False),
)

comments = Table(
    "comments",
    metadata,
    Column("comment_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("thread_id", PG_UUID(as_uuid=True), ForeignKey("workspace.threads.thread_id"), nullable=False),
    Column("body", Text, nullable=False),
    Column("author_id", PG_UUID(as_uuid=True), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=NOW),
    Column("edited_at", DateTime(timezone=True)),
)

# Data-Hub: dataset history rows written by handlers.py (one per source event), newest first per dataset.
dataset_activity = Table(
    "dataset_activity",
    metadata,
    Column("activity_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("dataset_id", PG_UUID(as_uuid=True), nullable=False),
    Column("type", Text, nullable=False),
    Column("label", Text),
    Column("ref_id", PG_UUID(as_uuid=True)),
    Column("actor_id", PG_UUID(as_uuid=True)),
    Column("project_id", PG_UUID(as_uuid=True)),
    Column("occurred_at", DateTime(timezone=True), nullable=False),
    Column("source_event_id", PG_UUID(as_uuid=True), nullable=False, unique=True),
)

# Data-Hub "trending" rail: governance.access.requested.v1 occurrences (7-day window at read time).
hub_access_requests = Table(
    "hub_access_requests",
    metadata,
    Column("access_request_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("dataset_id", PG_UUID(as_uuid=True), nullable=False),
    Column("requested_at", DateTime(timezone=True), nullable=False),
)

# Project outputs (spec §5.4). A FILE upload starts as status UPLOADING (an upload session, invisible to readers) and
# becomes READY on completion, when created_at is set. storage_org_code names the bucket (project lead organization).
outputs = Table(
    "outputs",
    metadata,
    Column("output_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("project_id", PG_UUID(as_uuid=True), nullable=False),
    Column("kind", Text, nullable=False),
    Column("title", Text, nullable=False),
    Column("access_level", Text, nullable=False),
    Column("status", Text, nullable=False),
    Column("storage_org_code", Text),
    Column("produced_by_run_id", PG_UUID(as_uuid=True)),
    Column("recipe_id", PG_UUID(as_uuid=True)),
    Column("recipe_version", Integer),
    Column("publish_status", Text, nullable=False, server_default=text("'NONE'")),
    Column("created_by", PG_UUID(as_uuid=True), nullable=False),
    Column("started_at", DateTime(timezone=True), nullable=False, server_default=NOW),
    Column("upload_expires_at", DateTime(timezone=True)),
    Column("created_at", DateTime(timezone=True)),
)

output_files = Table(
    "output_files",
    metadata,
    Column("output_id", PG_UUID(as_uuid=True), ForeignKey("workspace.outputs.output_id"), nullable=False),
    Column("position", Integer, nullable=False),
    Column("name", Text, nullable=False),
    Column("size_bytes", BigInteger, nullable=False),
    Column("sha256", Text, nullable=False),
    Column("media_type", Text, nullable=False),
    Column("object_key", Text, nullable=False),
    PrimaryKeyConstraint("output_id", "position"),
)

# Snapshot of the inputs an output derives from (titles and labels as they were when the output was created).
output_lineage_inputs = Table(
    "output_lineage_inputs",
    metadata,
    Column("output_id", PG_UUID(as_uuid=True), ForeignKey("workspace.outputs.output_id"), nullable=False),
    Column("position", Integer, nullable=False),
    Column("input_id", PG_UUID(as_uuid=True), nullable=False),
    Column("dataset_id", PG_UUID(as_uuid=True), nullable=False),
    Column("dataset_version_id", PG_UUID(as_uuid=True), nullable=False),
    Column("dataset_title", Text, nullable=False),
    Column("version_label", Text, nullable=False),
    PrimaryKeyConstraint("output_id", "position"),
)

# Recipes (spec §5.3): the live row carries the current version; recipe_versions keeps every saved version so a run
# executes exactly the version it pinned. Deletion is soft (runs and outputs keep their lineage).
recipes = Table(
    "recipes",
    metadata,
    Column("recipe_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("project_id", PG_UUID(as_uuid=True), nullable=False),
    Column("name", Text, nullable=False),
    Column("input_ids", ARRAY(PG_UUID(as_uuid=True)), nullable=False),
    Column("steps", JSONB, nullable=False),
    Column("version", Integer, nullable=False),
    Column("created_by", PG_UUID(as_uuid=True), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=NOW),
    Column("updated_by", PG_UUID(as_uuid=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False, server_default=NOW),
    Column("deleted_at", DateTime(timezone=True)),
)

recipe_versions = Table(
    "recipe_versions",
    metadata,
    Column("recipe_id", PG_UUID(as_uuid=True), ForeignKey("workspace.recipes.recipe_id"), nullable=False),
    Column("version", Integer, nullable=False),
    Column("name", Text, nullable=False),
    Column("input_ids", ARRAY(PG_UUID(as_uuid=True)), nullable=False),
    Column("steps", JSONB, nullable=False),
    Column("saved_by", PG_UUID(as_uuid=True), nullable=False),
    Column("saved_at", DateTime(timezone=True), nullable=False, server_default=NOW),
    PrimaryKeyConstraint("recipe_id", "version"),
)

# One QUEUED/RUNNING run per recipe (partial unique index). started_by_organization_id lets the worker re-check the
# starter's dataset access without a request context. attempt counts worker claims (infrastructure retries).
runs = Table(
    "runs",
    metadata,
    Column("run_id", PG_UUID(as_uuid=True), primary_key=True),
    Column("project_id", PG_UUID(as_uuid=True), nullable=False),
    Column("recipe_id", PG_UUID(as_uuid=True), nullable=False),
    Column("recipe_version", Integer, nullable=False),
    Column("status", Text, nullable=False),
    Column("started_by", PG_UUID(as_uuid=True), nullable=False),
    Column("started_by_organization_id", PG_UUID(as_uuid=True), nullable=False),
    Column("queued_at", DateTime(timezone=True), nullable=False, server_default=NOW),
    Column("started_at", DateTime(timezone=True)),
    Column("finished_at", DateTime(timezone=True)),
    Column("attempt", Integer, nullable=False, server_default=text("0")),
    Column("input_rows", BigInteger),
    Column("output_rows", BigInteger),
    Column("error", Text),
    Column("output_id", PG_UUID(as_uuid=True), ForeignKey("workspace.outputs.output_id")),
)

# The input versions a run pinned when it was started (titles/labels as they were then; output lineage copies them).
run_inputs = Table(
    "run_inputs",
    metadata,
    Column("run_id", PG_UUID(as_uuid=True), ForeignKey("workspace.runs.run_id"), nullable=False),
    Column("position", Integer, nullable=False),
    Column("input_id", PG_UUID(as_uuid=True), nullable=False),
    Column("dataset_id", PG_UUID(as_uuid=True), nullable=False),
    Column("dataset_version_id", PG_UUID(as_uuid=True), nullable=False),
    Column("dataset_title", Text, nullable=False),
    Column("version_label", Text, nullable=False),
    PrimaryKeyConstraint("run_id", "position"),
)
