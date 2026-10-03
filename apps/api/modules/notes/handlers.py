"""Evidence capture: other modules' events -> notes.evidence rows, the material of LLM drafts (drafting/).

A row is (project, researcher, Asia/Seoul day, openapi NoteEvidenceType, ref id, label, time). Labels are entity
labels only (dataset title@version, recipe name@version, row counts, output title, an error code); payload values are
read by name, so anything else a producer adds never lands here. payload keeps only the researcher's organization
when their own event says it (the evening schedule creates today's note in that organization).
Idempotent per handler through notes.processed_events (claim_event) and per source event (unique source_event_id).

Not recorded: workspace.input.removed.v1 and workspace.publish.decided.v1 (NoteEvidenceType has no type for them),
comments (not research activity), events without a project or without a user.
"""

from collections.abc import Callable
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy.orm import Session

from api.modules.notes import repo
from api.modules.notes.drafting.prompt import KST, MAX_LABEL_CHARS, one_line
from api.platform.event_bus import claim_event, subscribe
from api.platform.events import EventEnvelope
from api.platform.generated.event_types import EventType
from api.platform.ids import new_id

SCHEMA = "notes"
HANDLER = "notes_evidence"


def _record(
    session: Session,
    event: EventEnvelope,
    *,
    kind: str,
    project_id: Any,
    actor_id: Any,
    ref_id: Any,
    label: str,
    at: datetime | None = None,
) -> None:
    if project_id is None or actor_id is None:
        return
    actor = UUID(str(actor_id))
    moment = at or event.occurred_at
    payload: dict[str, str] = {}
    if event.actor.user_id == actor and event.actor.organization_id is not None:
        payload["organization_id"] = str(event.actor.organization_id)
    repo.insert_evidence(
        session,
        evidence_id=new_id(),
        project_id=UUID(str(project_id)),
        actor_id=actor,
        note_date=moment.astimezone(KST).date(),
        type=kind,
        ref_id=UUID(str(ref_id)),
        label=one_line(label, MAX_LABEL_CHARS) or kind,
        at=moment,
        payload=payload,
        source_event_id=event.event_id,
    )


def _workspace(kind: str, ref: str, label: Callable[[dict[str, Any]], str]) -> Callable[..., None]:
    """Workspace events carry project_id, actor_id (the researcher) and occurred_at in the payload."""

    def handle(session: Session, event: EventEnvelope) -> None:
        if not claim_event(session, SCHEMA, event, handler=HANDLER):
            return
        p = event.payload
        _record(
            session,
            event,
            kind=kind,
            project_id=p.get("project_id"),
            actor_id=p.get("actor_id"),
            ref_id=p[ref],
            label=label(p),
            at=datetime.fromisoformat(p["occurred_at"]) if p.get("occurred_at") else None,
        )

    handle.__name__ = handle.__qualname__ = f"on_{kind.lower()}"  # distinct subscription names
    return handle


def _recipe(p: dict[str, Any]) -> str:
    return f"{p['recipe_name']}@{p['recipe_version']}"


def _error_code(error: str) -> str:
    """Run errors are a stable code (older rows: `CODE: text`); only the code is kept (text could quote a value)."""
    code = error.split(":", 1)[0].strip()
    return code if code.replace("_", "").isalnum() and code.isupper() else "ERROR"


on_input_added = subscribe(EventType.WORKSPACE_INPUT_ADDED_V1)(
    _workspace("INPUT_ADDED", "input_id", lambda p: f"{p['dataset_title']}@{p['version_label']}")
)
on_input_version_changed = subscribe(EventType.WORKSPACE_INPUT_VERSION_CHANGED_V1)(
    _workspace(
        "INPUT_VERSION_CHANGED",
        "input_id",
        lambda p: f"{p['dataset_title']}@{p['previous_version_label']} → {p['version_label']}",
    )
)
on_recipe_saved = subscribe(EventType.WORKSPACE_RECIPE_SAVED_V1)(
    _workspace("RECIPE_SAVED", "recipe_id", lambda p: f"{_recipe(p)} · {int(p['step_count'])}단계")
)
on_run_succeeded = subscribe(EventType.WORKSPACE_RUN_SUCCEEDED_V1)(
    _workspace(
        "RUN_SUCCEEDED",
        "run_id",
        lambda p: f"{_recipe(p)} · {int(p['input_rows']):,}행 → {int(p['output_rows']):,}행",
    )
)
on_run_failed = subscribe(EventType.WORKSPACE_RUN_FAILED_V1)(
    _workspace("RUN_FAILED", "run_id", lambda p: f"{_recipe(p)} · {_error_code(str(p['error']))}")
)
on_output_created = subscribe(EventType.WORKSPACE_OUTPUT_CREATED_V1)(
    _workspace("OUTPUT_CREATED", "output_id", lambda p: str(p["output_title"]))
)
on_publish_requested = subscribe(EventType.WORKSPACE_PUBLISH_REQUESTED_V1)(
    _workspace("PUBLISH_REQUESTED", "request_id", lambda p: str(p["output_title"]))
)


@subscribe(EventType.GOVERNANCE_DOWNLOAD_AUTHORIZED_V1)
def on_download_authorized(session: Session, event: EventEnvelope) -> None:
    """The downloader is the event's user; a download outside a project is no note's evidence."""
    if not claim_event(session, SCHEMA, event, handler=HANDLER):
        return
    p = event.payload
    _record(
        session,
        event,
        kind="DATASET_DOWNLOADED",
        project_id=p.get("project_id"),
        actor_id=event.actor.user_id,
        ref_id=p["dataset_version_id"],
        label=f"데이터셋 파일 {len(p.get('file_ids') or [])}개 다운로드",
    )


@subscribe(EventType.GOVERNANCE_ACCESS_APPROVED_V1)
def on_access_approved(session: Session, event: EventEnvelope) -> None:
    """Evidence of the researcher the decision is about (not of the reviewer who made it)."""
    if not claim_event(session, SCHEMA, event, handler=HANDLER):
        return
    p = event.payload
    _record(
        session,
        event,
        kind="ACCESS_DECIDED",
        project_id=p.get("project_id"),
        actor_id=p.get("subject_user_id"),
        ref_id=p["access_request_id"],
        label="데이터 접근 승인",
    )


@subscribe(EventType.GOVERNANCE_ACCESS_REJECTED_V1)
def on_access_rejected(session: Session, event: EventEnvelope) -> None:
    """The reviewer's free-text reason is not kept."""
    if not claim_event(session, SCHEMA, event, handler=HANDLER):
        return
    p = event.payload
    _record(
        session,
        event,
        kind="ACCESS_DECIDED",
        project_id=p.get("project_id"),
        actor_id=p.get("requester_user_id"),
        ref_id=p["access_request_id"],
        label="데이터 접근 반려",
    )
