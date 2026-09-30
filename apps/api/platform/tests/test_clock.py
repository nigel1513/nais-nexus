from datetime import UTC, datetime

from api.platform import clock


def test_now_is_timezone_aware_utc() -> None:
    assert clock.now().tzinfo is UTC


def test_frozen_pins_now_and_restores() -> None:
    pinned = datetime(2026, 9, 30, 12, 0, tzinfo=UTC)
    with clock.frozen(pinned):
        assert clock.now() == pinned
    assert clock.now() != pinned
