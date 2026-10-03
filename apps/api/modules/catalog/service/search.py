"""searchDatasets (M03 §6.2): OpenSearch only; an outage is 503, there is no DB fallback.

A text search is hybrid: BM25 over the metadata fields plus k-NN over the document embedding (bge-m3). The query
embedding is best effort: without it (no embedding server, timeout, an index built before vectors) the search is
lexical only."""

import logging
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
from api.platform.search_index import embedding_text

logger = logging.getLogger("nais.catalog.search")


def query_vector(deps: CatalogDeps, q: str | None) -> list[float] | None:
    text = embedding_text(q)
    if not text or deps.query_embedder is None:
        return None
    try:
        if not deps.search.supports_vectors():
            return None
        return deps.query_embedder.embed([text])[0]
    except Exception as exc:
        logger.warning("query embedding unavailable; lexical search only", extra={"error": str(exc)[:300]})
        return None


def search_datasets(deps: CatalogDeps, user: CurrentUser, params: SearchParams) -> dict[str, Any]:
    if params.temporal_from and params.temporal_to and params.temporal_from > params.temporal_to:
        raise ApiError(
            ErrorCode.VALIDATION_FAILED,
            "temporal_from is after temporal_to.",
            {"fields": [{"field": "temporal_to", "reason": "TEMPORAL_RANGE"}]},
        )
    sort_name = resolve_sort(params)
    search_after = decode_search_cursor(params.cursor, sort_name) if params.cursor else None
    body = build_search_body(
        user,
        params,
        sort_name,
        search_after,
        vector=query_vector(deps, params.q),
        min_score=deps.settings.catalog_semantic_min_score,
    )
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
