"""searchDatasets (M03 §6.2): OpenSearch only; an outage is 503, there is no DB fallback."""

from typing import Any

from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.search.opensearch import SearchRejected, SearchUnavailable
from api.modules.catalog.search.query import (
    VOCABULARY_FACETS,
    SearchParams,
    build_search_body,
    decode_search_cursor,
    invalid_cursor,
    label_vocabulary_facets,
    map_search_response,
    resolve_sort,
)
from api.modules.catalog.service.vocabulary import labels
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode


def search_datasets(deps: CatalogDeps, user: CurrentUser, params: SearchParams) -> dict[str, Any]:
    if params.temporal_from and params.temporal_to and params.temporal_from > params.temporal_to:
        raise ApiError(
            ErrorCode.VALIDATION_FAILED,
            "temporal_from is after temporal_to.",
            {"fields": [{"field": "temporal_to", "reason": "TEMPORAL_RANGE"}]},
        )
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
    result = map_search_response(raw, limit=params.limit, sort_name=sort_name)
    if any(result["facets"].get(name) for name in VOCABULARY_FACETS):
        with deps.session_factory() as session:

            def labels_for(scheme: str, codes: list[str]) -> dict[str, str]:
                return {code: term["label_ko"] for code, term in labels(session, scheme, codes).items()}

            label_vocabulary_facets(result["facets"], labels_for)
    return result
