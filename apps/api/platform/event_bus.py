"""In-process handler registry (D-006). Delivery is at-least-once; handlers must be idempotent (claim_event)."""

import re
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, cast

from sqlalchemy import CursorResult, text
from sqlalchemy.orm import Session

from api.platform.events import EventEnvelope
from api.platform.generated.event_types import EventType

Handler = Callable[[Session, EventEnvelope], None]
_SCHEMA_NAME = re.compile(r"^[a-z][a-z_]{1,30}$")


@dataclass(frozen=True)
class Subscription:
    event_type: str
    handler: Handler
    name: str


class HandlerRegistry:
    def __init__(self) -> None:
        self._subscriptions: dict[str, list[Subscription]] = defaultdict(list)

    def subscribe(self, event_type: EventType | str) -> Callable[[Handler], Handler]:
        kind = EventType(event_type).value

        def decorator(handler: Handler) -> Handler:
            name = f"{handler.__module__}.{handler.__qualname__}"
            self._subscriptions[kind].append(Subscription(kind, handler, name))
            return handler

        return decorator

    def handlers_for(self, event_type: str) -> list[Subscription]:
        return list(self._subscriptions.get(event_type, []))


registry = HandlerRegistry()
subscribe = registry.subscribe


def claim_event(session: Session, schema: str, envelope: EventEnvelope) -> bool:
    """Insert into <schema>.processed_events; False means this consumer already handled the event."""
    if not _SCHEMA_NAME.fullmatch(schema):
        raise ValueError(f"invalid schema name: {schema!r}")
    result = cast(
        CursorResult[Any],
        session.execute(
            text(
                f'INSERT INTO "{schema}".processed_events (event_id, event_type) '
                "VALUES (:event_id, :event_type) ON CONFLICT (event_id) DO NOTHING"
            ),
            {"event_id": envelope.event_id, "event_type": envelope.event_type},
        ),
    )
    return result.rowcount == 1
