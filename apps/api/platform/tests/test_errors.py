import re

from fastapi import FastAPI, Query
from fastapi.testclient import TestClient

from api.platform.errors import ApiError, install_error_handlers
from api.platform.generated.error_codes import ErrorCode

HEX32 = re.compile(r"^[0-9a-f]{32}$")


def make_client() -> TestClient:
    app = FastAPI()
    install_error_handlers(app)

    @app.get("/expired")
    def expired() -> None:
        raise ApiError(ErrorCode.ACCESS_GRANT_EXPIRED, details={"access_grant_id": "g-1"})

    @app.get("/items")
    def items(limit: int = Query(20, ge=1, le=100)) -> dict[str, int]:
        return {"limit": limit}

    @app.get("/boom")
    def boom() -> None:
        raise RuntimeError("secret internals")

    return TestClient(app, raise_server_exceptions=False)


def test_api_error_uses_contract_status_and_envelope() -> None:
    response = make_client().get("/expired")
    assert response.status_code == 403
    error = response.json()["error"]
    assert error["code"] == "ACCESS_GRANT_EXPIRED"
    assert error["message"] == "The access grant has expired."
    assert error["details"] == {"access_grant_id": "g-1"}
    assert HEX32.match(error["trace_id"])


def test_request_validation_becomes_validation_failed_with_fields() -> None:
    response = make_client().get("/items", params={"limit": 0})
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "VALIDATION_FAILED"
    assert error["details"]["fields"][0]["field"] == "limit"


def test_unknown_route_is_not_found_envelope() -> None:
    response = make_client().get("/nope")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


def test_unhandled_exception_is_internal_error_without_leaking_details() -> None:
    response = make_client().get("/boom")
    assert response.status_code == 500
    error = response.json()["error"]
    assert error["code"] == "INTERNAL_ERROR"
    assert "secret" not in response.text


def test_api_error_accepts_plain_string_codes() -> None:
    assert ApiError("USER_DISABLED").status_code == 403
