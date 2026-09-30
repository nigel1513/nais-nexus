import time

from fastapi.testclient import TestClient

from api.platform.health import get_health_checks
from api.platform.settings import Settings
from api.platform.testing.app import create_test_app


def ok() -> None:
    return None


def down() -> None:
    raise ConnectionError("refused")


def hang() -> None:
    time.sleep(3)


def client_with(checks: dict, timeout: float = 2.0) -> TestClient:  # type: ignore[type-arg]
    app = create_test_app(settings=Settings(health_check_timeout_seconds=timeout))
    app.dependency_overrides[get_health_checks] = lambda: checks
    return TestClient(app)


def test_ready_when_all_dependencies_are_up() -> None:
    response = client_with({"postgres": ok, "redis": ok}).get("/api/v1/health/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "checks": {"postgres": "ok", "redis": "ok"}}


def test_not_ready_when_one_dependency_is_down() -> None:
    response = client_with({"postgres": ok, "opa": down}).get("/api/v1/health/ready")
    assert response.status_code == 503
    assert response.json() == {"status": "degraded", "checks": {"postgres": "ok", "opa": "down"}}


def test_hanging_check_times_out() -> None:
    started = time.monotonic()
    response = client_with({"opensearch": hang, "postgres": ok}, timeout=0.2).get("/api/v1/health/ready")
    assert time.monotonic() - started < 1.5
    assert response.status_code == 503
    assert response.json()["checks"] == {"opensearch": "down", "postgres": "ok"}


def test_default_checks_cover_the_gate_a_dependencies() -> None:
    from api.platform.health import default_health_checks

    assert set(default_health_checks()) == {"postgres", "redis", "opensearch", "opa"}
