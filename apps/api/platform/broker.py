"""Dramatiq broker must be set BEFORE modules are imported (their actors bind at import time)."""

import dramatiq
from dramatiq.brokers.redis import RedisBroker

from api.platform.settings import Settings


def configure_broker(settings: Settings, broker: dramatiq.Broker | None = None) -> dramatiq.Broker:
    chosen = broker if broker is not None else RedisBroker(url=settings.redis_url)  # type: ignore[no-untyped-call]  # dramatiq lacks annotations
    dramatiq.set_broker(chosen)
    return chosen
