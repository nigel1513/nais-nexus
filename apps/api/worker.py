"""Worker process: outbox relay + periodic jobs + Dramatiq actors. Run: python -m api.worker"""

import signal
import threading
from collections.abc import Sequence
from dataclasses import dataclass

import dramatiq
from dramatiq import Worker

from api.platform import relay
from api.platform.broker import configure_broker
from api.platform.db import session_factory
from api.platform.event_bus import registry
from api.platform.logs import configure_logging
from api.platform.modules import ModuleSpec, discover_modules
from api.platform.scheduler import Scheduler
from api.platform.settings import Settings, get_settings


@dataclass
class WorkerRuntime:
    broker: dramatiq.Broker
    scheduler: Scheduler
    modules: list[ModuleSpec]


def build_worker(
    *,
    modules: Sequence[ModuleSpec] | None = None,
    broker: dramatiq.Broker | None = None,
    settings: Settings | None = None,
) -> WorkerRuntime:
    settings = settings or get_settings()
    chosen = configure_broker(settings, broker)  # before module import: actors bind at import time
    specs = discover_modules() if modules is None else list(modules)
    scheduler = Scheduler()
    for spec in specs:
        if spec.wire is not None:
            spec.wire()
        if spec.register_worker is not None:
            spec.register_worker(chosen, scheduler)
    return WorkerRuntime(broker=chosen, scheduler=scheduler, modules=specs)


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    runtime = build_worker(settings=settings)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    threads = [
        threading.Thread(
            target=relay.run_forever,
            args=(stop, session_factory(), registry),
            kwargs={"batch_size": settings.outbox_batch_size, "max_attempts": settings.outbox_max_attempts},
            name="outbox-relay",
            daemon=True,
        ),
        threading.Thread(target=runtime.scheduler.run_forever, args=(stop,), name="scheduler", daemon=True),
    ]
    for thread in threads:
        thread.start()
    actor_worker = Worker(runtime.broker, worker_threads=settings.worker_threads)
    actor_worker.start()
    try:
        while not stop.is_set():
            stop.wait(1)
    finally:
        actor_worker.stop()
        for thread in threads:
            thread.join(timeout=10)


if __name__ == "__main__":
    main()
