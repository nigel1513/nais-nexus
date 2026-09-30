import uuid

from fastapi import APIRouter
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from api.platform.modules import ModuleSpec
from api.platform.testing.app import create_test_app


def test_liveness() -> None:
    response = TestClient(create_test_app()).get("/api/v1/health/live")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_valid_request_id_is_echoed_as_correlation_id() -> None:
    rid = "0192f0c0-0000-7000-8000-0000000000ab"
    response = TestClient(create_test_app()).get("/api/v1/health/live", headers={"X-Request-Id": rid})
    assert response.headers["X-Request-Id"] == rid


def test_nginx_style_hex_request_id_is_accepted() -> None:
    rid = "0192f0c0000070008000000000000abc"
    response = TestClient(create_test_app()).get("/api/v1/health/live", headers={"X-Request-Id": rid})
    assert response.headers["X-Request-Id"] == str(uuid.UUID(rid))


def test_invalid_request_id_is_replaced() -> None:
    client = TestClient(create_test_app())
    for junk in ("not-a-uuid", "x" * 2048):
        header = client.get("/api/v1/health/live", headers={"X-Request-Id": junk}).headers["X-Request-Id"]
        assert uuid.UUID(header).version == 7


def test_error_trace_id_matches_request_id() -> None:
    rid = "0192f0c0-0000-7000-8000-0000000000cd"
    response = TestClient(create_test_app()).get("/api/v1/missing", headers={"X-Request-Id": rid})
    assert response.json()["error"]["trace_id"] == uuid.UUID(rid).hex


def test_module_router_is_mounted_under_api_prefix_and_wired() -> None:
    wired: list[str] = []
    router = APIRouter()

    @router.get("/probe")
    def probe() -> dict[str, str]:
        return {"probe": "ok"}

    spec = ModuleSpec(name="probe", router=router, wire=lambda: wired.append("probe"))
    response = TestClient(create_test_app(modules=[spec])).get("/api/v1/probe")
    assert response.json() == {"probe": "ok"}
    assert wired == ["probe"]


def test_trace_id_comes_from_the_opentelemetry_span_when_enabled() -> None:
    exporter = InMemorySpanExporter()
    response = TestClient(create_test_app(span_exporter=exporter)).get("/api/v1/health/live")
    trace_ids = {span.context.trace_id for span in exporter.get_finished_spans()}
    assert uuid.UUID(response.headers["X-Request-Id"]).int in trace_ids
