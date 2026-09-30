from collections.abc import Sequence

import dramatiq
from fastapi import FastAPI
from opentelemetry.sdk.trace.export import SpanExporter

from api.platform import health
from api.platform.broker import configure_broker
from api.platform.errors import install_error_handlers
from api.platform.logs import configure_logging
from api.platform.middleware import correlation_middleware
from api.platform.modules import ModuleSpec, discover_modules
from api.platform.settings import Settings, get_settings
from api.platform.telemetry import configure_telemetry

API_PREFIX = "/api/v1"


def create_app(
    *,
    modules: Sequence[ModuleSpec] | None = None,
    settings: Settings | None = None,
    broker: dramatiq.Broker | None = None,
    span_exporter: SpanExporter | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)
    configure_broker(settings, broker)
    app = FastAPI(
        title="NAIS AI-OS API",
        version="0.1.0",
        docs_url=f"{API_PREFIX}/docs",
        openapi_url=f"{API_PREFIX}/openapi.json",
    )
    app.state.settings = settings
    app.middleware("http")(correlation_middleware)
    install_error_handlers(app)
    app.include_router(health.router, prefix=API_PREFIX)
    specs = discover_modules() if modules is None else list(modules)
    for spec in specs:
        if spec.wire is not None:
            spec.wire()
        if spec.router is not None:
            app.include_router(spec.router, prefix=API_PREFIX)
    app.state.modules = specs
    configure_telemetry(app, settings, span_exporter)
    return app
