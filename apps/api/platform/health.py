import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from redis import Redis
from sqlalchemy import text

from api.platform.db import engine_for
from api.platform.settings import get_settings

HealthCheck = Callable[[], None]
router = APIRouter(tags=["health"])
_executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="health")


def default_health_checks() -> dict[str, HealthCheck]:
    settings = get_settings()

    def postgres() -> None:
        with engine_for(settings.database_url).connect() as conn:
            conn.execute(text("SELECT 1"))

    def redis() -> None:
        Redis.from_url(settings.redis_url, socket_timeout=1, socket_connect_timeout=1).ping()

    def opensearch() -> None:
        httpx.get(f"{settings.opensearch_url}/_cluster/health", timeout=1.5).raise_for_status()

    def opa() -> None:
        httpx.get(f"{settings.opa_url}/health", timeout=1.5).raise_for_status()

    return {"postgres": postgres, "redis": redis, "opensearch": opensearch, "opa": opa}


def get_health_checks() -> dict[str, HealthCheck]:
    return default_health_checks()


def run_checks(checks: dict[str, HealthCheck], timeout_s: float) -> dict[str, str]:
    futures = {name: _executor.submit(check) for name, check in checks.items()}
    deadline = time.monotonic() + timeout_s
    results: dict[str, str] = {}
    for name, future in futures.items():
        try:
            future.result(timeout=max(0.0, deadline - time.monotonic()))
            results[name] = "ok"
        except Exception:
            results[name] = "down"
    return results


@router.get("/health/live")
def live() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/health/ready")
def ready(request: Request, checks: Annotated[dict[str, HealthCheck], Depends(get_health_checks)]) -> JSONResponse:
    results = run_checks(checks, request.app.state.settings.health_check_timeout_seconds)
    healthy = all(state == "ok" for state in results.values())
    return JSONResponse(
        {"status": "ok" if healthy else "degraded", "checks": results}, status_code=200 if healthy else 503
    )
