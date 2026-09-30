from fastapi import FastAPI
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SimpleSpanProcessor, SpanExporter

from api.platform.settings import Settings


def configure_telemetry(app: FastAPI, settings: Settings, exporter: SpanExporter | None = None) -> bool:
    """Instrument only when an OTLP endpoint (or a test exporter) is configured."""
    if exporter is None and not settings.otel_exporter_otlp_endpoint:
        return False
    provider = TracerProvider(resource=Resource.create({"service.name": settings.otel_service_name}))
    if exporter is not None:
        provider.add_span_processor(SimpleSpanProcessor(exporter))
    else:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        endpoint = f"{str(settings.otel_exporter_otlp_endpoint).rstrip('/')}/v1/traces"
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
    FastAPIInstrumentor.instrument_app(app, tracer_provider=provider)
    return True
