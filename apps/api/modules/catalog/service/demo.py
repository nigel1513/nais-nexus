"""Demo catalogue search (D-049 internal): the mock-mode web server keeps its demo datasets' public metadata in a
separate index (alias nais-demo-datasets) and searches it through the same query, analyzers and embeddings as
searchDatasets. Nothing here reads or writes the catalog database or the real index."""

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.interfaces import SearchIndex
from api.modules.catalog.search.documents import embed_documents
from api.modules.catalog.search.index_body import MAPPINGS
from api.modules.catalog.search.opensearch import SearchUnavailable
from api.modules.catalog.search.query import SearchParams
from api.modules.catalog.service.search import run_search
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode

MAX_DEMO_DOCUMENTS = 2000
REQUIRED_FIELDS = ("dataset_id", "title", "status", "access_level", "owner_organization_id")


@dataclass(frozen=True)
class DemoViewer:
    organization_id: UUID
    is_platform_admin: bool = False


def _index(deps: CatalogDeps) -> SearchIndex:
    if deps.demo_search is None:
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Demo search index is not configured.")
    return deps.demo_search


def _invalid(reason: str, message: str) -> ApiError:
    return ApiError(
        ErrorCode.VALIDATION_FAILED, message, {"fields": [{"field": "documents", "reason": reason}]}
    )


def sync_demo_datasets(deps: CatalogDeps, documents: list[dict[str, Any]]) -> dict[str, int]:
    """Makes the demo index equal to `documents` (index-document shape, without the embedding)."""
    index = _index(deps)
    allowed = set(MAPPINGS["properties"])
    for doc in documents:
        if unknown := sorted(set(doc) - allowed):
            raise _invalid("UNKNOWN_FIELD", f"Unknown document fields: {', '.join(unknown[:5])}.")
        if missing := [field for field in REQUIRED_FIELDS if not doc.get(field)]:
            raise _invalid("MISSING_FIELD", f"Missing document fields: {', '.join(missing)}.")
    docs = [dict(doc) for doc in documents]
    try:
        stale = sorted(set(index.document_ids()) - {str(doc["dataset_id"]) for doc in docs})
        if index.supports_vectors():
            embed_documents(docs, deps.embedder)
        index.bulk(docs, stale)
        index.refresh()
    except SearchUnavailable as exc:
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Demo search index is unavailable.") from exc
    return {"indexed": len(docs), "removed": len(stale)}


def search_demo_datasets(deps: CatalogDeps, viewer: DemoViewer, params: SearchParams) -> dict[str, Any]:
    """searchDatasets over the demo index for `viewer`; facet labels are left to the caller's own vocabulary."""
    return run_search(deps, _index(deps), viewer, params, label_facets=False)
