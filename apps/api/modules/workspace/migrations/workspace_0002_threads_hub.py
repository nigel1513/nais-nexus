"""workspace discussions (threads, comments) and Data-Hub read models (dataset activity, access requests)

Revision ID: workspace_0002
Revises: workspace_0001
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "workspace_0002"
down_revision = "workspace_0001"
branch_labels = None
depends_on = None

SCHEMA = "workspace"
NOW = sa.text("now()")
SCOPES = "('PROJECT', 'DATASET', 'OUTPUT', 'RECIPE')"
ACTIVITY_TYPES = (
    "('VERSION_PUBLISHED', 'METADATA_CHANGED', 'POLICY_CHANGED', 'READINESS_COMPLETED', 'USED_IN_PROJECT',"
    " 'OUTPUT_PUBLISHED', 'DISCUSSION_STARTED')"
)


def upgrade() -> None:
    op.create_table(
        "threads",
        sa.Column("thread_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("scope", sa.Text, nullable=False),
        sa.Column("target_id", UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", UUID(as_uuid=True), nullable=True),
        sa.Column("owner_organization_id", UUID(as_uuid=True), nullable=True),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("created_by", UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("resolved", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("comment_count", sa.Integer, nullable=False),
        sa.Column("last_comment_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(f"scope IN {SCOPES}", name="ck_threads_scope"),
        sa.CheckConstraint("(scope = 'DATASET') = (project_id IS NULL)", name="ck_threads_project"),
        sa.CheckConstraint("char_length(title) BETWEEN 1 AND 200", name="ck_threads_title_length"),
        sa.CheckConstraint("comment_count >= 1", name="ck_threads_comment_count"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_threads_target", "threads", ["scope", "target_id", sa.text("last_comment_at DESC")], schema=SCHEMA
    )
    op.create_index(
        "ix_threads_project",
        "threads",
        ["project_id", sa.text("last_comment_at DESC")],
        schema=SCHEMA,
        postgresql_where=sa.text("project_id IS NOT NULL"),
    )
    op.create_table(
        "comments",
        sa.Column("comment_id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "thread_id", UUID(as_uuid=True), sa.ForeignKey(f"{SCHEMA}.threads.thread_id"), nullable=False
        ),
        sa.Column("body", sa.Text, nullable=False),
        sa.Column("author_id", UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("char_length(body) BETWEEN 1 AND 10000", name="ck_comments_body_length"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_comments_thread", "comments", ["thread_id", "created_at", "comment_id"], schema=SCHEMA
    )
    op.create_table(
        "dataset_activity",
        sa.Column("activity_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("dataset_id", UUID(as_uuid=True), nullable=False),
        sa.Column("type", sa.Text, nullable=False),
        sa.Column("label", sa.Text, nullable=True),
        sa.Column("ref_id", UUID(as_uuid=True), nullable=True),
        sa.Column("actor_id", UUID(as_uuid=True), nullable=True),
        sa.Column("project_id", UUID(as_uuid=True), nullable=True),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source_event_id", UUID(as_uuid=True), nullable=False),
        sa.CheckConstraint(f"type IN {ACTIVITY_TYPES}", name="ck_dataset_activity_type"),
        sa.UniqueConstraint("source_event_id", name="uq_dataset_activity_source_event"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_dataset_activity_dataset",
        "dataset_activity",
        ["dataset_id", sa.text("occurred_at DESC"), sa.text("activity_id DESC")],
        schema=SCHEMA,
    )
    op.create_table(
        "hub_access_requests",
        sa.Column("access_request_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("dataset_id", UUID(as_uuid=True), nullable=False),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_hub_access_requests_recent", "hub_access_requests", ["requested_at", "dataset_id"], schema=SCHEMA
    )


def downgrade() -> None:
    op.drop_table("hub_access_requests", schema=SCHEMA)
    op.drop_table("dataset_activity", schema=SCHEMA)
    op.drop_table("comments", schema=SCHEMA)
    op.drop_table("threads", schema=SCHEMA)
