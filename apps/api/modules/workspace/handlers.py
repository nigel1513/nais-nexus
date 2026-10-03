"""Event consumers feeding the Data-Hub read models (spec §4). Idempotent per handler through
workspace.processed_events (claim_event), and each activity row is unique per source event.

- dataset_activity: catalog version/metadata/policy events, readiness completions, this module's input additions
  and DATASET discussion starts. Labels are entity labels only (version label, access level, thread title), never
  data values; USED_IN_PROJECT keeps no label (the project name is read live for members).
  workspace.input.removed.v1 adds no row: DatasetActivityType has no removal type, and history keeps the use.
- hub_access_requests: governance.access.requested.v1 occurrences for the 7-day "trending" rail.
"""

from uuid import UUID

from sqlalchemy.orm import Session

from api.modules.workspace import repo
from api.platform.event_bus import claim_event, subscribe
from api.platform.events import EventEnvelope
from api.platform.generated.event_types import EventType
from api.platform.ids import new_id

SCHEMA = "workspace"


def _activity(
    session: Session,
    event: EventEnvelope,
    kind: str,
    *,
    label: str | None = None,
    ref_id: str | None = None,
    project_id: str | None = None,
) -> None:
    payload = event.payload
    repo.record_activity(
        session,
        activity_id=new_id(),
        dataset_id=UUID(payload["dataset_id"]),
        type=kind,
        label=label,
        ref_id=UUID(ref_id) if ref_id else None,
        actor_id=event.actor.user_id,
        project_id=UUID(project_id) if project_id else None,
        occurred_at=event.occurred_at,
        source_event_id=event.event_id,
    )


@subscribe(EventType.CATALOG_DATASET_VERSION_PUBLISHED_V1)
def on_version_published(session: Session, event: EventEnvelope) -> None:
    if claim_event(session, SCHEMA, event, handler="hub_activity"):
        p = event.payload
        _activity(
            session, event, "VERSION_PUBLISHED", label=p["version_label"], ref_id=p["dataset_version_id"]
        )


@subscribe(EventType.CATALOG_DATASET_METADATA_CHANGED_V1)
def on_metadata_changed(session: Session, event: EventEnvelope) -> None:
    if claim_event(session, SCHEMA, event, handler="hub_activity"):
        _activity(session, event, "METADATA_CHANGED")


@subscribe(EventType.CATALOG_DATASET_POLICY_CHANGED_V1)
def on_policy_changed(session: Session, event: EventEnvelope) -> None:
    if claim_event(session, SCHEMA, event, handler="hub_activity"):
        _activity(session, event, "POLICY_CHANGED")


@subscribe(EventType.CATALOG_DATASET_ACCESS_LEVEL_CHANGED_V1)
def on_access_level_changed(session: Session, event: EventEnvelope) -> None:
    if claim_event(session, SCHEMA, event, handler="hub_activity"):
        _activity(session, event, "POLICY_CHANGED", label=event.payload["access_level"])


@subscribe(EventType.READINESS_VALIDATION_COMPLETED_V1)
def on_readiness_completed(session: Session, event: EventEnvelope) -> None:
    if not claim_event(session, SCHEMA, event, handler="hub_activity"):
        return
    p = event.payload
    if p["run_status"] == "COMPLETED":  # a FAILED run is an operational error, not dataset history
        _activity(
            session, event, "READINESS_COMPLETED", label=p["overall_status"], ref_id=p["dataset_version_id"]
        )


@subscribe(EventType.WORKSPACE_INPUT_ADDED_V1)
def on_input_added(session: Session, event: EventEnvelope) -> None:
    if claim_event(session, SCHEMA, event, handler="hub_activity"):
        p = event.payload
        _activity(session, event, "USED_IN_PROJECT", ref_id=p["project_id"], project_id=p["project_id"])


@subscribe(EventType.WORKSPACE_COMMENT_ADDED_V1)
def on_comment_added(session: Session, event: EventEnvelope) -> None:
    if not claim_event(session, SCHEMA, event, handler="hub_activity"):
        return
    p = event.payload
    if p["scope"] == "DATASET" and p["new_thread"]:
        repo.record_activity(
            session,
            activity_id=new_id(),
            dataset_id=UUID(p["target_id"]),
            type="DISCUSSION_STARTED",
            label=p["thread_title"],
            ref_id=UUID(p["thread_id"]),
            actor_id=event.actor.user_id,
            project_id=None,
            occurred_at=event.occurred_at,
            source_event_id=event.event_id,
        )


@subscribe(EventType.GOVERNANCE_ACCESS_REQUESTED_V1)
def on_access_requested(session: Session, event: EventEnvelope) -> None:
    if claim_event(session, SCHEMA, event, handler="hub_trending"):
        p = event.payload
        repo.record_access_request(
            session, UUID(p["access_request_id"]), UUID(p["dataset_id"]), event.occurred_at
        )
