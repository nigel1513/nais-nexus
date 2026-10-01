"""searchDatasets (M03 §6.2): OpenSearch only; an outage is 503, there is no DB fallback."""

from typing import Any

from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.search.opensearch import SearchRejected, SearchUnavailable
from api.modules.catalog.search.query import (
    SearchParams,
    build_search_body,
    decode_search_cursor,
    invalid_cursor,
    map_search_response,
    resolve_sort,
)
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode


def search_datasets(deps: CatalogDeps, user: CurrentUser, params: SearchParams) -> dict[str, Any]:
    sort_name = resolve_sort(params)
    search_after = decode_search_cursor(params.cursor, sort_name) if params.cursor else None
    body = build_search_body(user, params, sort_name, search_after)
    try:
        raw = deps.search.search(body)
    except SearchRejected as exc:
        if search_after is not None:
            raise invalid_cursor() from exc
        raise ApiError(ErrorCode.VALIDATION_FAILED, "Invalid search request.") from exc
    except SearchUnavailable as exc:
        raise ApiError(
            ErrorCode.DEPENDENCY_UNAVAILABLE, "Dataset search is temporarily unavailable."
        ) from exc
    return map_search_response(raw, limit=params.limit, sort_name=sort_name)
