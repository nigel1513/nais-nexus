"""Keyset pagination over (timestamp, id) sort keys with the platform's opaque cursor (api.platform.pagination)."""

from collections.abc import Callable, Sequence
from datetime import datetime
from uuid import UUID

from sqlalchemy.engine import RowMapping

from api.modules.workspace.repo import SortKey
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.pagination import Page, PageInfo, PageParams, encode_cursor


def _invalid() -> ApiError:
    return ApiError(
        ErrorCode.VALIDATION_FAILED,
        "Invalid pagination cursor.",
        {"fields": [{"field": "cursor", "reason": "INVALID_CURSOR"}]},
    )


def sort_key(params: PageParams) -> SortKey | None:
    """The decoded cursor as (aware timestamp, id); any other shape is 422 VALIDATION_FAILED (INVALID_CURSOR)."""
    if params.cursor is None:
        return None
    try:
        at, ident = params.cursor
        key = (datetime.fromisoformat(str(at)), UUID(str(ident)))
    except (TypeError, ValueError) as exc:
        raise _invalid() from exc
    if key[0].tzinfo is None:
        raise _invalid()
    return key


def keyset_page[T](
    rows: Sequence[RowMapping],
    limit: int,
    key: tuple[str, str],
    views: Callable[[Sequence[RowMapping]], list[T]],
) -> Page[T]:
    """rows were fetched with limit + 1; key names the (timestamp, id) columns of the sort order."""
    has_more = len(rows) > limit
    shown = rows[:limit]
    next_cursor = None
    if has_more and shown:
        last = shown[-1]
        next_cursor = encode_cursor([last[key[0]].isoformat(), str(last[key[1]])])
    return Page(items=views(shown), page=PageInfo(next_cursor=next_cursor, has_more=has_more))
