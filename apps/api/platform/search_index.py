"""Minimal OpenSearch REST client over httpx (no extra dependency), shared by the modules that own a search index.

One instance is one alias: readers and writers use the alias, a full reindex builds `<alias>-vN` and swaps it.
Every index gets the same Korean/English analyzer and, when the cluster has the k-NN plugin, an `embedding` field
for hybrid (lexical + semantic) search.
"""

import copy
import json
import logging
import re
import threading
import time
from collections.abc import Mapping, Sequence
from typing import Any

import httpx

logger = logging.getLogger("nais.search")

# bge-m3 (NAIS_EMBED_MODEL): one vector per document.
EMBEDDING_FIELD = "embedding"
EMBEDDING_DIMENSION = 1024
# What an embedding request may carry: bge-m3 takes 8k tokens, Korean text stays under that at 4,000 characters.
EMBEDDING_MAX_CHARS = 4000
_VECTOR_CHECK_TTL_S = 60.0


class SearchUnavailable(RuntimeError):
    pass


class SearchRejected(ValueError):
    pass


def embedding_mapping() -> dict[str, Any]:
    return {
        "type": "knn_vector",
        "dimension": EMBEDDING_DIMENSION,
        "method": {"name": "hnsw", "engine": "lucene", "space_type": "cosinesimil"},
    }


def analysis(nori: bool) -> dict[str, Any]:
    normalizer = {"lc": {"type": "custom", "filter": ["lowercase"]}}
    if nori:
        return {
            "analyzer": {
                "ko_en": {
                    "type": "custom",
                    "tokenizer": "nori_mixed",
                    "filter": ["lowercase", "nori_part_of_speech", "nori_readingform"],
                }
            },
            "tokenizer": {"nori_mixed": {"type": "nori_tokenizer", "decompound_mode": "mixed"}},
            "normalizer": normalizer,
        }
    # Fallback when analysis-nori is not installed: same index name, weaker Korean morphology (M03 §10).
    return {
        "analyzer": {
            "ko_en": {"type": "custom", "tokenizer": "standard", "filter": ["lowercase", "cjk_bigram"]}
        },
        "normalizer": normalizer,
    }


def body_for(mappings: Mapping[str, Any], *, nori: bool, vectors: bool) -> dict[str, Any]:
    """Index body: the shared analyzers, plus the embedding field when the cluster can hold vectors."""
    settings: dict[str, Any] = {"number_of_shards": 1, "analysis": analysis(nori)}
    result = copy.deepcopy(dict(mappings))
    if vectors:
        settings["index"] = {"knn": True}
        result["properties"][EMBEDDING_FIELD] = embedding_mapping()
    return {"settings": settings, "mappings": result}


def _client_for(url: str, timeout: float) -> httpx.Client:
    parsed = httpx.URL(url)
    auth = (parsed.username, parsed.password) if parsed.username else None
    port = f":{parsed.port}" if parsed.port else ""
    base = f"{parsed.scheme}://{parsed.host}{port}{parsed.path.rstrip('/')}"
    return httpx.Client(base_url=base, auth=auth, timeout=timeout)


class OpenSearchIndex:
    def __init__(
        self,
        base_url: str,
        alias: str,
        *,
        mappings: Mapping[str, Any],
        id_field: str,
        version: int,
        timeout: float = 5.0,
    ) -> None:
        self.alias = alias
        self._mappings = mappings
        self._id_field = id_field
        self._version = version
        self._client = _client_for(base_url, timeout)
        self._ready = False
        self._lock = threading.Lock()
        self._plugins: frozenset[str] | None = None
        self._vectors: dict[str, tuple[float, bool]] = {}

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            response = self._client.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise SearchUnavailable(f"{method} {path}: {exc}") from exc
        if response.status_code >= 500:
            raise SearchUnavailable(f"{method} {path}: HTTP {response.status_code} {response.text[:300]}")
        return response

    @staticmethod
    def _ok(response: httpx.Response) -> httpx.Response:
        if response.status_code >= 400:
            raise SearchUnavailable(f"HTTP {response.status_code}: {response.text[:500]}")
        return response

    def _installed(self) -> frozenset[str]:
        if self._plugins is None:
            plugins = self._ok(self._request("GET", "/_cat/plugins", params={"format": "json"})).json()
            self._plugins = frozenset(str(plugin.get("component")) for plugin in plugins)
        return self._plugins

    def nori_available(self) -> bool:
        return "analysis-nori" in self._installed()

    def knn_available(self) -> bool:
        return "opensearch-knn" in self._installed()

    def create_index(self, name: str, *, exist_ok: bool = True) -> None:
        nori, vectors = self.nori_available(), self.knn_available()
        if not nori:
            logger.warning("analysis-nori not installed; using the fallback analyzer", extra={"index": name})
        if not vectors:
            logger.warning("opensearch-knn not installed; the index is lexical only", extra={"index": name})
        response = self._request("PUT", f"/{name}", json=body_for(self._mappings, nori=nori, vectors=vectors))
        if exist_ok and response.status_code == 400 and "resource_already_exists_exception" in response.text:
            return
        self._ok(response)

    def ensure(self) -> None:
        if self._ready:
            return
        with self._lock:
            if self._ready:
                return
            if self._request("HEAD", f"/_alias/{self.alias}").status_code != 200:
                first = f"{self.alias}-v{self._version}"
                self.create_index(first)
                self._ok(
                    self._request(
                        "POST",
                        "/_aliases",
                        json={"actions": [{"add": {"index": first, "alias": self.alias}}]},
                    )
                )
            self._ready = True

    def supports_vectors(self, index: str | None = None) -> bool:
        """Whether documents may carry `embedding` (the index behind the alias was built with the k-NN field).
        An index built before vectors existed answers False until the next full reindex; rechecked every minute
        because the reindex that swaps the alias runs in another process."""
        self.ensure()
        target = index or self.alias
        cached = self._vectors.get(target)
        now = time.monotonic()
        if cached and now - cached[0] < _VECTOR_CHECK_TTL_S:
            return cached[1]
        mapping = self._ok(self._request("GET", f"/{target}/_mapping")).json()
        found = bool(mapping) and all(
            EMBEDDING_FIELD in entry.get("mappings", {}).get("properties", {}) for entry in mapping.values()
        )
        self._vectors[target] = (now, found)
        return found

    def bulk(
        self, upserts: Sequence[Mapping[Any, Any]], deletes: Sequence[str], *, index: str | None = None
    ) -> None:
        self.ensure()
        target = index or self.alias
        lines: list[str] = []
        for doc in upserts:
            lines.append(json.dumps({"index": {"_index": target, "_id": str(doc[self._id_field])}}))
            lines.append(json.dumps(doc, ensure_ascii=False, default=str))
        for doc_id in deletes:
            lines.append(json.dumps({"delete": {"_index": target, "_id": str(doc_id)}}))
        if not lines:
            return
        response = self._ok(
            self._request(
                "POST",
                "/_bulk",
                content="\n".join(lines) + "\n",
                headers={"Content-Type": "application/x-ndjson"},
            )
        )
        body = response.json()
        if body.get("errors"):
            failed = [
                result
                for item in body.get("items", [])
                for action, result in item.items()
                if result.get("status", 200) >= 300
                and not (action == "delete" and result.get("status") == 404)
            ]
            if failed:
                raise SearchUnavailable(f"bulk request had {len(failed)} failures: {failed[:3]}")

    def search(self, body: Mapping[Any, Any]) -> dict[str, Any]:
        self.ensure()
        response = self._request("POST", f"/{self.alias}/_search", json=dict(body))
        if response.status_code == 400:
            raise SearchRejected(response.text[:500])
        result: dict[str, Any] = self._ok(response).json()
        return result

    def document_ids(self) -> list[str]:
        """Ids of every document behind the alias (small indexes only: the demo catalogue, the public projects)."""
        self.ensure()
        body = {"query": {"match_all": {}}, "size": 10_000, "_source": False}
        raw = self._ok(self._request("POST", f"/{self.alias}/_search", json=body)).json()
        return [str(hit["_id"]) for hit in raw["hits"]["hits"]]

    def refresh(self) -> None:
        self.ensure()
        self._ok(self._request("POST", f"/{self.alias}/_refresh"))

    def next_index_name(self) -> str:
        response = self._request(
            "GET", f"/_cat/indices/{self.alias}-v*", params={"format": "json", "h": "index"}
        )
        if response.status_code != 404:
            self._ok(response)
        names = [item["index"] for item in response.json()] if response.status_code == 200 else []
        pattern = re.compile(rf"^{re.escape(self.alias)}-v(\d+)$")
        numbers = [int(match.group(1)) for name in names if (match := pattern.match(name))]
        return f"{self.alias}-v{max(numbers, default=0) + 1}"

    def swap_alias(self, new_index: str) -> list[str]:
        response = self._request("GET", f"/_alias/{self.alias}")
        current = sorted(response.json()) if response.status_code == 200 else []
        actions: list[dict[str, Any]] = [{"remove": {"index": name, "alias": self.alias}} for name in current]
        actions.append({"add": {"index": new_index, "alias": self.alias}})
        self._ok(self._request("POST", "/_aliases", json={"actions": actions}))
        self._ready = True
        self._vectors.clear()
        return current


def embedding_text(*parts: str | None) -> str:
    """The text a document or a query is embedded from: its non-empty parts, one per line, cut to the model limit."""
    return "\n".join(part.strip() for part in parts if part and part.strip())[:EMBEDDING_MAX_CHARS]
