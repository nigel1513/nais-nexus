"""Minimal periodic job runner for the worker (e.g. M04 grant expiry sweeper every 60 s)."""

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

logger = logging.getLogger("nais.scheduler")


@dataclass
class PeriodicJob:
    name: str
    interval_s: float
    fn: Callable[[], None]
    next_run: float


class Scheduler:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._jobs: list[PeriodicJob] = []

    @property
    def job_names(self) -> list[str]:
        return [job.name for job in self._jobs]

    def every(
        self, interval_s: float, name: str, fn: Callable[[], None], *, run_immediately: bool = False
    ) -> None:
        if interval_s <= 0:
            raise ValueError("interval_s must be positive")
        if name in self.job_names:
            raise ValueError(f"duplicate job name: {name}")
        first_run = self._clock() + (0 if run_immediately else interval_s)
        self._jobs.append(PeriodicJob(name, interval_s, fn, first_run))

    def run_pending(self) -> list[str]:
        ran: list[str] = []
        now = self._clock()
        for job in self._jobs:
            if job.next_run > now:
                continue
            try:
                job.fn()
            except Exception:
                logger.exception("scheduled job failed", extra={"job": job.name})
            job.next_run = now + job.interval_s
            ran.append(job.name)
        return ran

    def run_forever(self, stop: threading.Event, tick_s: float = 0.5) -> None:
        while not stop.is_set():
            self.run_pending()
            stop.wait(tick_s)
