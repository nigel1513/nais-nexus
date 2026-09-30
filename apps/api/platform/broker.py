"""Dramatiq broker must be set BEFORE modules are imported (their actors bind at import time)."""

import logging
from contextlib import AbstractContextManager
from typing import Any
from uuid import UUID

import dramatiq
from dramatiq.broker import MessageProxy
from dramatiq.brokers.redis import RedisBroker
from dramatiq.middleware import Middleware

from api.platform.context import use_correlation_id
from api.platform.ids import new_id
from api.platform.settings import Settings

logger = logging.getLogger("nais.broker")


def _message_correlation_id(message: MessageProxy) -> UUID:
    raw = message.options.get("correlation_id")
    if raw:
        try:
            return UUID(str(raw))
        except ValueError:
            logger.warning("ignoring invalid correlation_id option", extra={"message_id": message.message_id})
    return new_id()


class CorrelationMiddleware(Middleware):
    """Each message runs under its own correlation id (the message's `correlation_id` option, else fresh)."""

    def __init__(self) -> None:
        self._scopes: dict[str, AbstractContextManager[None]] = {}

    def before_process_message(self, broker: dramatiq.Broker, message: MessageProxy) -> None:
        scope = use_correlation_id(_message_correlation_id(message))
        scope.__enter__()
        self._scopes[message.message_id] = scope

    def _reset(self, message: MessageProxy) -> None:
        scope = self._scopes.pop(message.message_id, None)
        if scope is not None:
            scope.__exit__(None, None, None)

    def after_process_message(
        self,
        broker: dramatiq.Broker,
        message: MessageProxy,
        *,
        result: Any = None,
        exception: BaseException | None = None,
    ) -> None:
        self._reset(message)

    def after_skip_message(self, broker: dramatiq.Broker, message: MessageProxy) -> None:
        self._reset(message)


def configure_broker(settings: Settings, broker: dramatiq.Broker | None = None) -> dramatiq.Broker:
    chosen = broker if broker is not None else RedisBroker(url=settings.redis_url)  # type: ignore[no-untyped-call]  # dramatiq lacks annotations
    if not any(isinstance(m, CorrelationMiddleware) for m in chosen.middleware):
        chosen.add_middleware(CorrelationMiddleware())
    dramatiq.set_broker(chosen)
    return chosen
