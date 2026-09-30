import uuid

import dramatiq
from dramatiq import Worker
from dramatiq.brokers.stub import StubBroker

from api.platform.broker import configure_broker
from api.platform.context import correlation_id
from api.platform.settings import Settings


def test_each_message_gets_its_own_stable_correlation_id() -> None:
    broker = configure_broker(Settings(), StubBroker())
    seen: list[tuple[str, uuid.UUID, uuid.UUID]] = []

    @dramatiq.actor(queue_name="correlation_probe")
    def probe(tag: str) -> None:
        seen.append((tag, correlation_id(), correlation_id()))

    pinned = uuid.UUID("0192f0c0-0000-7000-8000-0000000000aa")
    probe.send("a")
    probe.send("b")
    probe.send_with_options(args=("pinned",), correlation_id=str(pinned))
    worker = Worker(broker, worker_threads=1)
    worker.start()
    try:
        broker.join("correlation_probe")
        worker.join()
    finally:
        worker.stop()

    by_tag = {tag: (first, second) for tag, first, second in seen}
    assert set(by_tag) == {"a", "b", "pinned"}
    assert all(first == second for first, second in by_tag.values())
    assert by_tag["a"][0] != by_tag["b"][0]
    assert by_tag["pinned"][0] == pinned
