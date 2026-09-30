from collections.abc import Sequence

import dramatiq
from dramatiq.brokers.stub import StubBroker
from fastapi import FastAPI
from opentelemetry.sdk.trace.export import SpanExporter

from api.platform.app import create_app
from api.platform.modules import ModuleSpec
from api.platform.settings import Settings


def create_test_app(
    *,
    modules: Sequence[ModuleSpec] = (),
    settings: Settings | None = None,
    broker: dramatiq.Broker | None = None,
    span_exporter: SpanExporter | None = None,
) -> FastAPI:
    """App with only the given modules, a StubBroker and default Settings. For module agents' tests too."""
    return create_app(
        modules=list(modules),
        settings=settings or Settings(),
        broker=broker or StubBroker(),
        span_exporter=span_exporter,
    )
