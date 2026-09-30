"""Single source of 'now' so tests can pin time."""

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime

_frozen_at: datetime | None = None


def now() -> datetime:
    return _frozen_at if _frozen_at is not None else datetime.now(UTC)


@contextmanager
def frozen(at: datetime) -> Iterator[None]:
    global _frozen_at
    previous = _frozen_at
    _frozen_at = at
    try:
        yield
    finally:
        _frozen_at = previous
