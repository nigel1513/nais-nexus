from typing import Any

import dramatiq
from dramatiq.brokers.stub import StubBroker

from api.platform.modules import ModuleSpec
from api.platform.settings import Settings
from api.worker import build_worker


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
