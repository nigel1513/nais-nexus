"""The catalog's OpenSearch index (alias nais-datasets): the shared client with the dataset mapping."""

from api.modules.catalog.search.index_body import INDEX_VERSION, MAPPINGS
from api.platform.search_index import OpenSearchIndex as _OpenSearchIndex
from api.platform.search_index import SearchRejected, SearchUnavailable

__all__ = ["OpenSearchIndex", "SearchRejected", "SearchUnavailable"]


class OpenSearchIndex(_OpenSearchIndex):
    def __init__(self, base_url: str, alias: str, *, timeout: float = 5.0) -> None:
        super().__init__(
            base_url, alias, mappings=MAPPINGS, id_field="dataset_id", version=INDEX_VERSION, timeout=timeout
        )
