"""Event consumers (M03 §3.2, §7.2). Idempotent per handler through catalog.processed_events (D-006)."""

from uuid import UUID

from sqlalchemy import and_, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from api.modules.catalog.repo import enqueue_index
from api.modules.catalog.tables import datasets, readiness_summaries
from api.platform.event_bus import claim_event, subscribe
from api.platform.events import EventEnvelope

SCHEMA = "catalog"


@subscribe("readiness.validation.completed.v1")
def on_readiness_completed(session: Session, event: EventEnvelope) -> None:
    if not claim_event(session, SCHEMA, event, handler="readiness_summary"):
        return
    payload = event.payload
    stmt = pg_insert(readiness_summaries).values(
        dataset_version_id=UUID(payload["dataset_version_id"]),
        profile_id=payload["profile_id"],
        dataset_id=UUID(payload["dataset_id"]),
        validation_id=UUID(payload["validation_id"]),
        run_status=payload["run_status"],
        overall_status=payload["overall_status"],
        completed_at=event.occurred_at,
        source_event_id=event.event_id,
    )
    excluded = stmt.excluded
    changed = session.execute(
        stmt.on_conflict_do_update(
            index_elements=[readiness_summaries.c.dataset_version_id, readiness_summaries.c.profile_id],
            set_={
                "dataset_id": excluded.dataset_id,
                "validation_id": excluded.validation_id,
                "run_status": excluded.run_status,
                "overall_status": excluded.overall_status,
                "completed_at": excluded.completed_at,
                "source_event_id": excluded.source_event_id,
            },
            # order-independent: FAILED never replaces COMPLETED; COMPLETED replaces FAILED regardless of time;
            # same status: strictly newer wins (ties keep the stored row)
            where=or_(
                and_(excluded.run_status == "COMPLETED", readiness_summaries.c.run_status == "FAILED"),
                and_(
                    excluded.run_status == readiness_summaries.c.run_status,
                    readiness_summaries.c.completed_at < excluded.completed_at,
                ),
            ),
        ).returning(readiness_summaries.c.dataset_version_id)
    ).first()
    if changed is not None:
        enqueue_index(session, UUID(payload["dataset_id"]))


@subscribe("identity.organization.created.v1")
def on_organization_created(session: Session, event: EventEnvelope) -> None:
    """Organization names are denormalized into search documents: re-index that organization's datasets."""
    if not claim_event(session, SCHEMA, event, handler="organization_reindex"):
        return
    organization_id = UUID(event.payload["organization_id"])
    owned: list[UUID] = list(
        session.execute(
            select(datasets.c.dataset_id).where(datasets.c.owner_organization_id == organization_id)
        ).scalars()
    )
    for dataset_id in owned:
        enqueue_index(session, dataset_id)
