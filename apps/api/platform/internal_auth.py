"""Server-to-server endpoints (openapi tag `Internal`, D-049): the shared header token, and body parsing after it.

The header X-NAIS-Internal-Token must equal NAIS_INTERNAL_TOKEN. While that setting is empty the endpoints do not
exist (404 NOT_FOUND); a missing or wrong token is 403 FORBIDDEN. A POST/PUT body is not declared as a FastAPI body
parameter (FastAPI would read and validate it before any dependency ran) but read with `read_body` once the token
passed, so a malformed request without the token is still 404/403.
"""

import hmac

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ValidationError

from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode


def check_internal_token(expected: str, token: str | None) -> None:
    if not expected:
        raise ApiError(ErrorCode.NOT_FOUND, "Not found.")
    if token is None or not hmac.compare_digest(token.encode(), expected.encode()):
        raise ApiError(ErrorCode.FORBIDDEN, "Internal token missing or wrong.")


async def read_body[T: BaseModel](request: Request, model: type[T]) -> T:
    raw = await request.body()
    try:
        return model.model_validate_json(raw or b"null")
    except ValidationError as exc:
        raise RequestValidationError(
            [{"loc": ("body", *e["loc"]), "msg": e["msg"], "type": e["type"]} for e in exc.errors()]
        ) from exc


def body_schema(model: type[BaseModel]) -> dict[str, object]:
    """openapi_extra for an endpoint whose body is read with `read_body`."""
    return {
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": model.model_json_schema()}},
        }
    }
