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
    value = _correlation_id.get()
    if value is None:
        value = new_id()
        _correlation_id.set(value)
    return value


def trace_id() -> str:
    return correlation_id().hex


@contextmanager
def use_correlation_id(value: UUID) -> Iterator[None]:
    token = _correlation_id.set(value)
    try:
        yield
    finally:
        _correlation_id.reset(token)
