"""Event handlers (spec §7). Subscribed to EVERY event type; each claims per handler (D-006)."""

import logging
from dataclasses import asdict
from uuid import UUID

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from api.modules.audit import ports as audit_ports
from api.modules.audit.mapping import NOT_AUDITED, to_audit_record
from api.modules.audit.notification_rules import build_drafts
from api.modules.audit.notifications import deliver
from api.modules.audit.tables import audit_events
from api.platform import event_bus
from api.platform.event_bus import Handler, HandlerRegistry, claim_event
from api.platform.events import EventEnvelope
from api.platform.generated.event_types import EventType
from api.platform.ids import new_id

SCHEMA = "audit"
logger = logging.getLogger("nais.audit")


def _display_name(user_id: UUID | None) -> str | None:
    if user_id is None:
        return None
    try:
        profile = audit_ports.identity().get_public_profiles([user_id]).get(user_id)
    except Exception:
        # Audit must never be lost to a display-name lookup; the name is a convenience copy.
        logger.warning("identity lookup failed; recording audit without display name", exc_info=True)
        return None
    return profile.display_name[:200] if profile is not None else None


def audit_writer(session: Session, event: EventEnvelope) -> None:
    if not claim_event(session, SCHEMA, event, handler="audit_writer"):
        return
    # A malformed payload makes to_audit_record raise: the claim rolls back with the transaction and the
    # relay retries then dead-letters, so a poison event is surfaced rather than silently unaudited.
    record = to_audit_record(event)
    if record is None:
        if event.event_type not in NOT_AUDITED:
            logger.warning(
                "no audit mapping for event type",
                extra={"event_type": event.event_type, "event_id": str(event.event_id)},
            )
        return
    display_name = _display_name(record.actor_user_id) if record.actor_type == "USER" else None
    session.execute(
        pg_insert(audit_events)
        .values(audit_event_id=new_id(), actor_display_name=display_name, **asdict(record))
        .on_conflict_do_nothing(index_elements=[audit_events.c.source_event_id])
    )


def notifier(session: Session, event: EventEnvelope) -> None:
    if not claim_event(session, SCHEMA, event, handler="notifier"):
        return
    drafts = build_drafts(event)
    if drafts:
        deliver(session, event, drafts)


HANDLERS: tuple[Handler, ...] = (audit_writer, notifier)


def register(registry: HandlerRegistry) -> None:
    for event_type in EventType:
        for handler in HANDLERS:
            registry.subscribe(event_type)(handler)


register(event_bus.registry)
