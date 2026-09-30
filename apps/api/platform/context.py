"""Request/event correlation id. trace_id is always correlation_id.hex."""

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from uuid import UUID

from api.platform.ids import new_id

_correlation_id: ContextVar[UUID | None] = ContextVar("nais_correlation_id", default=None)


def set_correlation_id(value: UUID) -> None:
    _correlation_id.set(value)


def correlation_id() -> UUID:
    """The id set for this request/job/message, or a fresh one-off id (NOT stored) when none is set.

    Stable scopes are opened by the HTTP middleware (set_correlation_id), the scheduler, the Dramatiq
    CorrelationMiddleware and the outbox relay (use_correlation_id). Never cache a generated id on a thread.
    """
    value = _correlation_id.get()
    return new_id() if value is None else value


def trace_id() -> str:
    return correlation_id().hex


@contextmanager
def use_correlation_id(value: UUID) -> Iterator[None]:
    token = _correlation_id.set(value)
    try:
        yield
    finally:
        _correlation_id.reset(token)
