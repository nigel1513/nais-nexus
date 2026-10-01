import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DataError
from starlette.exceptions import HTTPException as StarletteHTTPException

from api.platform.context import trace_id
from api.platform.generated.error_codes import DESCRIPTION, HTTP_STATUS, ErrorCode

logger = logging.getLogger("nais.errors")

_STATUS_TO_CODE: dict[int, ErrorCode] = {
    401: ErrorCode.UNAUTHENTICATED,
    403: ErrorCode.FORBIDDEN,
    404: ErrorCode.NOT_FOUND,
    405: ErrorCode.NOT_FOUND,
    409: ErrorCode.CONFLICT,
    429: ErrorCode.RATE_LIMITED,
}


def _is_nul_character_error(exc: DataError) -> bool:
    """psycopg refuses NUL in text parameters client-side; PostgreSQL itself rejects it as UntranslatableCharacter."""
    text = str(exc.orig)
    return type(exc.orig).__name__ == "UntranslatableCharacter" or "NUL (0x00)" in text


class ApiError(Exception):
    """Raise anywhere in a request to return the contract error envelope."""

    def __init__(
        self, code: ErrorCode | str, message: str | None = None, details: dict[str, Any] | None = None
    ) -> None:
        self.code = ErrorCode(code)
        self.status_code = HTTP_STATUS[self.code]
        self.message = message or DESCRIPTION[self.code]
        self.details = details
        super().__init__(f"{self.code}: {self.message}")


DomainError = ApiError


def error_body(code: ErrorCode, message: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code.value, "message": message, "trace_id": trace_id()}
    if details:
        error["details"] = details
    return {"error": error}


async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
    logger.error("unhandled error", exc_info=exc)
    return JSONResponse(error_body(ErrorCode.INTERNAL_ERROR, "Unexpected server error."), status_code=500)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(error_body(exc.code, exc.message, exc.details), status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        fields = [
            {
                "field": ".".join(str(part) for part in err["loc"][1:]) or str(err["loc"][0]),
                "reason": err["msg"],
            }
            for err in exc.errors()
        ]
        body = error_body(ErrorCode.VALIDATION_FAILED, "Request validation failed.", {"fields": fields})
        return JSONResponse(body, status_code=422)

    @app.exception_handler(DataError)
    async def _data_error(_: Request, exc: DataError) -> JSONResponse:
        if not _is_nul_character_error(exc):  # any other DataError is a server bug: stays a 500
            return await _unhandled(_, exc)
        body = error_body(
            ErrorCode.VALIDATION_FAILED,
            "Request validation failed.",
            {"fields": [{"field": "(request)", "reason": "INVALID_CHARACTER"}]},
        )
        return JSONResponse(body, status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _STATUS_TO_CODE.get(exc.status_code, ErrorCode.INTERNAL_ERROR)
        return JSONResponse(error_body(code, DESCRIPTION[code]), status_code=HTTP_STATUS[code])

    app.add_exception_handler(Exception, _unhandled)
