"""Worker process: outbox relay + periodic jobs + Dramatiq actors. Run: python -m api.worker"""

import logging
import signal
import threading
from collections.abc import Sequence
from dataclasses import dataclass, field

import dramatiq
from dramatiq import Worker
from dramatiq.common import q_name

from api.platform import relay
from api.platform.broker import configure_broker
from api.platform.db import session_factory
from api.platform.event_bus import HandlerRegistry, registry
from api.platform.logs import configure_logging
from api.platform.modules import ModuleSpec, discover_modules
from api.platform.scheduler import Scheduler
from api.platform.settings import Settings, get_settings

logger = logging.getLogger("nais.worker")


@dataclass
class WorkerRuntime:
    broker: dramatiq.Broker
    scheduler: Scheduler
    modules: list[ModuleSpec]
    dedicated_queues: dict[str, int] = field(default_factory=dict)


def build_worker(
    *,
    modules: Sequence[ModuleSpec] | None = None,
    broker: dramatiq.Broker | None = None,
    settings: Settings | None = None,
    registry: HandlerRegistry = registry,
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
    # Handlers subscribe at import time: a module must import its handler modules from its package __init__,
    # otherwise its events are relayed with no handler and silently marked dispatched.
    logger.info("event subscriptions", extra={"subscriptions": registry.table()})
    dedicated: dict[str, int] = {}
    for spec in specs:
        dedicated.update(spec.dedicated_queues)
    return WorkerRuntime(broker=chosen, scheduler=scheduler, modules=specs, dedicated_queues=dedicated)


def make_actor_workers(runtime: WorkerRuntime, settings: Settings) -> list[Worker]:
    """One Worker per dedicated queue group plus a general Worker for every other declared queue.

    Dramatiq treats an empty/None `queues` set as "all queues", so a worker is only built for a non-empty set.
    """
    declared = {q_name(q) for q in runtime.broker.get_declared_queues()}  # delay queues follow their queue
    workers: list[Worker] = []
    for queue, threads in runtime.dedicated_queues.items():
        if queue in declared:
            workers.append(Worker(runtime.broker, queues={queue}, worker_threads=threads))
    rest = declared - set(runtime.dedicated_queues)
    if rest:
        workers.append(Worker(runtime.broker, queues=rest, worker_threads=settings.worker_threads))
    return workers


def supervise(stop: threading.Event, threads: Sequence[threading.Thread], *, poll_s: float = 1.0) -> int:
    """Monitor worker threads and return exit code.

    Returns 1 if a thread dies unexpectedly, 0 if stop was set normally.
    Logs errors and sets stop if any thread dies.
    """
    while not stop.is_set():
        for t in threads:
            if not t.is_alive():
                logger.error("worker thread died; shutting down", extra={"worker_thread": t.name})
                stop.set()
                return 1
        stop.wait(poll_s)
    return 0


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
    actor_workers = make_actor_workers(runtime, settings)
    for actor_worker in actor_workers:
        actor_worker.start()
        logger.info(
            "actor worker started",
            extra={
                "queues": sorted(actor_worker.consumer_whitelist or []),
                "threads": actor_worker.worker_threads,
            },
        )
    try:
        code = supervise(stop, threads)
    finally:
        for actor_worker in actor_workers:
            actor_worker.stop(timeout=settings.worker_shutdown_timeout_ms)
        for thread in threads:
            thread.join(timeout=10)
    raise SystemExit(code)


if __name__ == "__main__":
    main()
