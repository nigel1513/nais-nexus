import logging
import threading
from typing import Any

import dramatiq
import pytest
from dramatiq.brokers.stub import StubBroker

from api.platform.event_bus import HandlerRegistry
from api.platform.modules import ModuleSpec
from api.platform.settings import Settings
from api.worker import build_worker, supervise


def test_build_worker_sets_broker_wires_modules_and_registers_jobs() -> None:
    calls: list[Any] = []

    def register(broker: dramatiq.Broker, scheduler: Any) -> None:
        scheduler.every(60, "probe.sweep", lambda: None)
        calls.append(broker)

    spec = ModuleSpec(name="probe", wire=lambda: calls.append("wired"), register_worker=register)
    broker = StubBroker()
    runtime = build_worker(modules=[spec], broker=broker, settings=Settings())
    assert calls == ["wired", broker]
    assert runtime.scheduler.job_names == ["probe.sweep"]
    assert dramatiq.get_broker() is broker


def test_supervise_returns_1_when_thread_dies() -> None:
    """A thread whose target returns immediately → supervise returns 1 and stop is set."""
    stop = threading.Event()
    thread = threading.Thread(target=lambda: None, name="test-thread")
    thread.start()
    thread.join()  # Ensure thread is dead before supervise checks it
    code = supervise(stop, [thread], poll_s=0.01)
    assert code == 1
    assert stop.is_set()


def test_supervise_returns_0_when_stop_set_normally() -> None:
    """A thread that waits on stop, with stop set from a timer after ~0.05s → supervise returns 0."""
    stop = threading.Event()
    waiter = threading.Thread(target=lambda: stop.wait(), name="waiter")
    waiter.start()
    timer = threading.Timer(0.05, stop.set)
    timer.start()
    code = supervise(stop, [waiter], poll_s=0.01)
    timer.cancel()
    waiter.join()
    assert code == 0
    assert stop.is_set()


def test_build_worker_logs_the_subscription_table(caplog: pytest.LogCaptureFixture) -> None:
    registry = HandlerRegistry()

    @registry.subscribe("project.archived.v1")
    def on_archived(session, event) -> None: ...  # type: ignore[no-untyped-def]

    with caplog.at_level(logging.INFO, logger="nais.worker"):
        build_worker(modules=[], broker=StubBroker(), settings=Settings(), registry=registry)
    [record] = [r for r in caplog.records if r.getMessage() == "event subscriptions"]
    assert record.levelno == logging.INFO
    assert record.subscriptions == {  # type: ignore[attr-defined]
        "project.archived.v1": [
            f"{__name__}.test_build_worker_logs_the_subscription_table.<locals>.on_archived"
        ]
    }


def _declared(broker: StubBroker, *names: str) -> None:
    for name in names:
        broker.declare_queue(name)


def test_make_actor_workers_splits_dedicated_queue_from_general() -> None:
    from api.worker import make_actor_workers

    broker = StubBroker()
    _declared(broker, "default", "audit", "readiness")
    spec = ModuleSpec(name="probe", dedicated_queues={"readiness": 2})
    runtime = build_worker(modules=[spec], broker=broker, settings=Settings())
    workers = make_actor_workers(runtime, Settings(worker_threads=5))
    by_queues = {frozenset(w.consumer_whitelist): w.worker_threads for w in workers}
    assert by_queues == {frozenset({"readiness"}): 2, frozenset({"default", "audit"}): 5}


def test_make_actor_workers_without_dedicated_is_one_general_worker() -> None:
    from api.worker import make_actor_workers

    broker = StubBroker()
    _declared(broker, "default")
    runtime = build_worker(modules=[], broker=broker, settings=Settings())
    (worker,) = make_actor_workers(runtime, Settings(worker_threads=3))
    assert worker.worker_threads == 3
    assert worker.consumer_whitelist == {"default"}


def test_make_actor_workers_never_builds_a_worker_with_an_empty_queue_set() -> None:
    """Dramatiq treats a falsy queue set as "all queues": only the dedicated queue exists -> no general worker."""
    from api.worker import make_actor_workers

    broker = StubBroker()
    _declared(broker, "readiness")
    spec = ModuleSpec(name="probe", dedicated_queues={"readiness": 2})
    runtime = build_worker(modules=[spec], broker=broker, settings=Settings())
    (worker,) = make_actor_workers(runtime, Settings(worker_threads=5))
    assert worker.consumer_whitelist == {"readiness"}
    assert worker.worker_threads == 2


def test_dedicated_queue_message_is_only_consumed_by_dedicated_worker() -> None:
    from api.worker import make_actor_workers

    broker = StubBroker()
    _declared(broker, "default", "readiness")
    spec = ModuleSpec(name="probe", dedicated_queues={"readiness": 1})
    runtime = build_worker(modules=[spec], broker=broker, settings=Settings())
    for w in make_actor_workers(runtime, Settings()):
        w.start()
        try:
            assert set(w.consumers) == {q for q in w.consumers if q.split(".")[0] in w.consumer_whitelist}
            assert ("readiness" in w.consumers) == ("readiness" in w.consumer_whitelist)
            assert ("default" in w.consumers) == ("default" in w.consumer_whitelist)
        finally:
            w.stop()
