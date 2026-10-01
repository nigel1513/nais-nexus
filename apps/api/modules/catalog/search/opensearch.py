"""Minimal OpenSearch REST client over httpx (no extra dependency). The alias is what readers and writers use."""

import json
import logging
import re
import threading
from collections.abc import Mapping, Sequence
from typing import Any

import httpx

from api.modules.catalog.search.index_body import INDEX_VERSION, index_body

logger = logging.getLogger("nais.catalog.search")


class SearchUnavailable(RuntimeError):
    pass


class SearchRejected(ValueError):
    pass


def _client_for(url: str, timeout: float) -> httpx.Client:
    parsed = httpx.URL(url)
    auth = (parsed.username, parsed.password) if parsed.username else None
    port = f":{parsed.port}" if parsed.port else ""
    base = f"{parsed.scheme}://{parsed.host}{port}{parsed.path.rstrip('/')}"
    return httpx.Client(base_url=base, auth=auth, timeout=timeout)


class OpenSearchIndex:
    def __init__(self, base_url: str, alias: str, *, timeout: float = 5.0) -> None:
        self.alias = alias
        self._client = _client_for(base_url, timeout)
        self._ready = False
        self._lock = threading.Lock()

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

    def nori_available(self) -> bool:
        plugins = self._ok(self._request("GET", "/_cat/plugins", params={"format": "json"})).json()
        return any(plugin.get("component") == "analysis-nori" for plugin in plugins)

    def create_index(self, name: str, *, exist_ok: bool = True) -> None:
        nori = self.nori_available()
        if not nori:
            logger.warning("analysis-nori not installed; using the fallback analyzer", extra={"index": name})
        response = self._request("PUT", f"/{name}", json=index_body(nori=nori))
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
                first = f"{self.alias}-v{INDEX_VERSION}"
                self.create_index(first)
                self._ok(
                    self._request(
                        "POST",
                        "/_aliases",
                        json={"actions": [{"add": {"index": first, "alias": self.alias}}]},
                    )
                )
            self._ready = True

    def bulk(
        self, upserts: Sequence[Mapping[Any, Any]], deletes: Sequence[str], *, index: str | None = None
    ) -> None:
        self.ensure()
        target = index or self.alias
        lines: list[str] = []
        for doc in upserts:
            lines.append(json.dumps({"index": {"_index": target, "_id": str(doc["dataset_id"])}}))
            lines.append(json.dumps(doc, ensure_ascii=False, default=str))
        for dataset_id in deletes:
            lines.append(json.dumps({"delete": {"_index": target, "_id": str(dataset_id)}}))
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
        return current
