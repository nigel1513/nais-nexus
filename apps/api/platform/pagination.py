"""Opaque cursor pagination. A cursor is base64url(JSON list of the sort key of the last item)."""

import base64
import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Annotated, Any, Generic, TypeVar

from fastapi import Query
from pydantic import BaseModel

from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode

T = TypeVar("T")
MAX_CURSOR_LENGTH = 512


class PageInfo(BaseModel):
    next_cursor: str | None = None
    has_more: bool


class Page(BaseModel, Generic[T]):
    items: list[T]
    page: PageInfo


@dataclass(frozen=True)
class PageParams:
    cursor: list[Any] | None
    limit: int


def _invalid_cursor() -> ApiError:
    return ApiError(
        ErrorCode.VALIDATION_FAILED,
        "Invalid pagination cursor.",
        {"fields": [{"field": "cursor", "reason": "INVALID_CURSOR"}]},
    )


def encode_cursor(values: Sequence[Any]) -> str:
    raw = json.dumps(values, separators=(",", ":"), default=str).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> list[Any]:
    try:
        if len(cursor) > MAX_CURSOR_LENGTH:
            raise ValueError("cursor too long")
        padded = cursor + "=" * (-len(cursor) % 4)
        value = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
    except (ValueError, UnicodeError) as exc:
        raise _invalid_cursor() from exc
    if not isinstance(value, list) or not value:
        raise _invalid_cursor()
    return value


def page_params(
    cursor: Annotated[str | None, Query(max_length=MAX_CURSOR_LENGTH)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> PageParams:
    return PageParams(cursor=decode_cursor(cursor) if cursor else None, limit=limit)


def build_page(rows: Sequence[T], limit: int, key: Callable[[T], Sequence[Any]]) -> Page[T]:
    has_more = len(rows) > limit
    items = list(rows[:limit])
    next_cursor = encode_cursor(key(items[-1])) if has_more and items else None
    return Page(items=items, page=PageInfo(next_cursor=next_cursor, has_more=has_more))
