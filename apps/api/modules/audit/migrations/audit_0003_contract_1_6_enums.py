"""widen the audit enum CHECK constraints to contract 1.6.0 (workspace / research notes; D-043, D-044, D-047)

Also admits DATASET_UPDATED (catalog.dataset.metadata_changed.v1), added to AuditAction after audit_0001 froze its list.

Revision ID: audit_0003
Revises: audit_0002
"""

from alembic import op

revision = "audit_0003"
down_revision = "audit_0002"
branch_labels = None
depends_on = None

SCHEMA = "audit"

# Frozen copies of the openapi enums (contract 1.6.0) at the time of this revision; migrations must not drift with
# the contract, so a later enum value needs a later migration (test_schema inserts every current value).
ACTIONS = (
    "LOGIN",
    "USER_CREATED",
    "ORGANIZATION_CREATED",
    "ADMIN_ROLE_CHANGED",
    "PROJECT_CREATED",
    "PROJECT_ARCHIVED",
    "PROJECT_MEMBER_ADDED",
    "PROJECT_MEMBER_REMOVED",
    "PROJECT_MEMBER_ROLE_CHANGED",
    "DATASET_CREATED",
    "DATASET_VERSION_PUBLISHED",
    "DATASET_UPDATED",
    "POLICY_CHANGED",
    "ACCESS_REQUESTED",
    "ACCESS_REVIEW_STARTED",
    "ACCESS_APPROVED",
    "ACCESS_REJECTED",
    "ACCESS_CHANGES_REQUESTED",
    "ACCESS_WITHDRAWN",
    "ACCESS_REVOKED",
    "ACCESS_EXPIRED",
    "FILE_DOWNLOADED",
    "DOWNLOAD_DENIED",
    "READINESS_VALIDATION_COMPLETED",
    "PROJECT_INPUT_ADDED",
    "PROJECT_INPUT_VERSION_CHANGED",
    "PROJECT_INPUT_REMOVED",
    "RECIPE_SAVED",
    "RUN_SUCCEEDED",
    "RUN_FAILED",
    "OUTPUT_CREATED",
    "OUTPUT_PUBLISH_REQUESTED",
    "OUTPUT_PUBLISH_DECIDED",
    "COMMENT_ADDED",
    "NOTE_SUBMITTED",
    "NOTE_SIGNED",
    "NOTE_REJECTED",
    "NOTE_VIEWED",
)
RESOURCE_TYPES = (
    "USER",
    "ORGANIZATION",
    "MEMBERSHIP",
    "PROJECT",
    "PROJECT_MEMBER",
    "DATASET",
    "DATASET_VERSION",
    "DATASET_FILE",
    "ACCESS_REQUEST",
    "ACCESS_GRANT",
    "READINESS_VALIDATION",
    "PROJECT_INPUT",
    "RECIPE",
    "RUN",
    "OUTPUT",
    "PUBLISH_REQUEST",
    "THREAD",
    "RESEARCH_NOTE",
)
NOTIFICATION_TYPES = (
    "PROJECT_INVITATION",
    "ACCESS_SUBMITTED",
    "ACCESS_APPROVED",
    "ACCESS_REJECTED",
    "ACCESS_CHANGES_REQUESTED",
    "ACCESS_EXPIRING",
    "ACCESS_REVOKED",
    "DATASET_PUBLISHED",
    "OUTPUT_PUBLISH_REQUESTED",
    "OUTPUT_PUBLISH_DECIDED",
    "NOTE_SUBMITTED",
    "NOTE_REJECTED",
    "NOTE_SIGNED",
    "DATASET_COMMENT_ADDED",
    "RUN_FAILED",
)

# audit_0001's lists, restored on downgrade.
PREVIOUS_ACTIONS = (
    ACTIONS[: ACTIONS.index("DATASET_UPDATED")]
    + ACTIONS[ACTIONS.index("DATASET_UPDATED") + 1 : ACTIONS.index("PROJECT_INPUT_ADDED")]
)
PREVIOUS_RESOURCE_TYPES = RESOURCE_TYPES[: RESOURCE_TYPES.index("PROJECT_INPUT")]
PREVIOUS_NOTIFICATION_TYPES = NOTIFICATION_TYPES[: NOTIFICATION_TYPES.index("OUTPUT_PUBLISH_REQUESTED")]

CHECKS = (
    ("ck_audit_events_action", "audit_events", "action"),
    ("ck_audit_events_resource_type", "audit_events", "resource_type"),
    ("ck_notifications_type", "notifications", "type"),
)


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def _replace(lists: tuple[tuple[str, ...], ...]) -> None:
    for (name, table, column), values in zip(CHECKS, lists, strict=True):
        op.drop_constraint(name, table, schema=SCHEMA, type_="check")
        op.create_check_constraint(name, table, _in(column, values), schema=SCHEMA)


def upgrade() -> None:
    _replace((ACTIONS, RESOURCE_TYPES, NOTIFICATION_TYPES))


def downgrade() -> None:
    _replace((PREVIOUS_ACTIONS, PREVIOUS_RESOURCE_TYPES, PREVIOUS_NOTIFICATION_TYPES))
