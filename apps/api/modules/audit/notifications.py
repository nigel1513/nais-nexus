"""Persist notification drafts: in-app row + (optionally) a PENDING email row (spec §7.3, §5)."""

import logging
from collections.abc import Sequence

from sqlalchemy import insert
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from api.modules.audit import ports as audit_ports
from api.modules.audit.email_queue import enqueue_after_commit
from api.modules.audit.notification_rules import NotificationDraft
from api.modules.audit.settings import get_audit_settings
from api.modules.audit.tables import email_deliveries, notifications
from api.platform.events import EventEnvelope
from api.platform.ids import new_id

logger = logging.getLogger("nais.audit")


def deliver(session: Session, event: EventEnvelope, drafts: Sequence[NotificationDraft]) -> int:
    settings = get_audit_settings()
    identity = audit_ports.identity()
    queued = 0
    for draft in drafts:
        # M09-R4: build_drafts does not pre-filter subjects; never notify a disabled/unknown user.
        if not identity.is_active_user(draft.recipient_user_id):
            continue
        notification_id = session.execute(
            pg_insert(notifications)
            .values(
                notification_id=new_id(),
                recipient_user_id=draft.recipient_user_id,
                type=draft.type.value,
                title=draft.title[:300],
                body=draft.body,
                link=draft.link[:500],
                source_event_id=event.event_id,
            )
            .on_conflict_do_nothing(
                index_elements=[notifications.c.source_event_id, notifications.c.recipient_user_id]
            )
            .returning(notifications.c.notification_id)
        ).scalar_one_or_none()
        if notification_id is None or not settings.notification_email_enabled:
            continue
        address = identity.get_email(draft.recipient_user_id)
        if not address:
            logger.warning(
                "recipient has no email; in-app only", extra={"user_id": str(draft.recipient_user_id)}
            )
            continue
        session.execute(
            insert(email_deliveries).values(
                email_delivery_id=new_id(), notification_id=notification_id, to_address=address
            )
        )
        queued += 1
    if queued:
        enqueue_after_commit(session)
    return queued
