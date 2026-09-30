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
