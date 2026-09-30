from collections.abc import Awaitable, Callable
from uuid import UUID

from fastapi import Request, Response
from opentelemetry import trace

from api.platform.context import set_correlation_id
from api.platform.ids import new_id


def _parse_request_id(raw: str | None) -> UUID | None:
    if not raw or len(raw) > 36:
        return None
    try:
        return UUID(raw)
    except ValueError:
        return None


def _otel_trace_uuid() -> UUID | None:
    span_context = trace.get_current_span().get_span_context()
    return UUID(int=span_context.trace_id) if span_context.is_valid else None


async def correlation_middleware(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    correlation = _otel_trace_uuid() or _parse_request_id(request.headers.get("x-request-id")) or new_id()
    set_correlation_id(correlation)
    response = await call_next(request)
    response.headers["X-Request-Id"] = str(correlation)
    return response
