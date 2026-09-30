"""Transactional outbox (D-005): write the event in the SAME session/transaction as the business change."""

from typing import Any
from uuid import UUID

from sqlalchemy import BigInteger, Column, DateTime, Integer, MetaData, Table, Text, insert
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Session

from api.platform import clock
from api.platform.context import correlation_id as current_correlation_id
from api.platform.events import EventActor, EventEnvelope, validate_envelope
from api.platform.generated.event_types import PRODUCER, EventType
from api.platform.ids import new_id

metadata = MetaData(schema="platform")

outbox_events = Table(
    "outbox_events",
    metadata,
    Column("id", BigInteger, primary_key=True),
    Column("event_id", PG_UUID(as_uuid=True), nullable=False),
    Column("event_type", Text, nullable=False),
    Column("envelope", JSONB, nullable=False),
    Column("created_at", DateTime(timezone=True)),
    Column("attempts", Integer),
    Column("next_attempt_at", DateTime(timezone=True)),
    Column("dispatched_at", DateTime(timezone=True)),
    Column("dead_at", DateTime(timezone=True)),
    Column("last_error", Text),
)


class OutboxWriter:
    def write(
        self,
        session: Session,
        event_type: EventType | str,
        payload: dict[str, Any],
        actor: EventActor,
        correlation_id: UUID | None = None,
    ) -> UUID:
        kind = EventType(event_type)
        envelope = EventEnvelope(
            event_id=new_id(),
            event_type=kind.value,
            occurred_at=clock.now(),
            producer=PRODUCER[kind],
            correlation_id=correlation_id or current_correlation_id(),
            actor=actor,
            payload=payload,
        )
        data = envelope.model_dump(mode="json")
        validate_envelope(data)
        session.execute(
            insert(outbox_events).values(event_id=envelope.event_id, event_type=kind.value, envelope=data)
        )
        return envelope.event_id


outbox = OutboxWriter()
