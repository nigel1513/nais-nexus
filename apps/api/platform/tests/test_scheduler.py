import pytest

from api.platform.scheduler import Scheduler


class FakeClock:
    def __init__(self) -> None:
        self.value = 0.0

    def __call__(self) -> float:
        return self.value


def test_jobs_run_when_due_and_are_rescheduled() -> None:
    clock = FakeClock()
    ran: list[str] = []
    scheduler = Scheduler(clock=clock)
    scheduler.every(60, "sweep", lambda: ran.append("sweep"))
    assert scheduler.run_pending() == []
    clock.value = 60
    assert scheduler.run_pending() == ["sweep"]
    clock.value = 119
    assert scheduler.run_pending() == []
    clock.value = 120
    assert scheduler.run_pending() == ["sweep"]
    assert ran == ["sweep", "sweep"]


def test_run_immediately() -> None:
    scheduler = Scheduler(clock=FakeClock())
    scheduler.every(60, "now", lambda: None, run_immediately=True)
    assert scheduler.run_pending() == ["now"]


def test_failing_job_does_not_stop_others() -> None:
    clock = FakeClock()
    ran: list[str] = []
    scheduler = Scheduler(clock=clock)

    def broken() -> None:
        raise RuntimeError("boom")

    scheduler.every(1, "broken", broken)
    scheduler.every(1, "fine", lambda: ran.append("fine"))
    clock.value = 1
    assert scheduler.run_pending() == ["broken", "fine"]
    assert ran == ["fine"]


def test_invalid_and_duplicate_jobs_are_rejected() -> None:
    scheduler = Scheduler(clock=FakeClock())
    with pytest.raises(ValueError):
        scheduler.every(0, "zero", lambda: None)
    scheduler.every(1, "dup", lambda: None)
    with pytest.raises(ValueError):
        scheduler.every(1, "dup", lambda: None)
