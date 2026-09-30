import threading
import time
from typing import Any

import dramatiq
from dramatiq.brokers.stub import StubBroker

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
