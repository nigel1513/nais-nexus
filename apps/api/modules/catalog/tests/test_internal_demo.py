"""/internal/demo/datasets*: the mock-mode web server's demo catalogue goes through the real search engine."""

import uuid
from dataclasses import replace
from typing import Any

import pytest

from api.modules.catalog.search.opensearch import OpenSearchIndex
from api.modules.catalog.tests.support import ORG_A, ORG_B
from api.modules.catalog.tests.support_api import CatalogApi
from api.modules.catalog.tests.test_opensearch_index import make_doc
from api.modules.catalog.tests.test_search_api import ConceptEmbedder
from api.platform.testing.contracts import assert_matches_response

TOKEN = {"X-NAIS-Internal-Token": "s3cret"}


@pytest.fixture
def demo_api(api: CatalogApi, search_index: OpenSearchIndex) -> CatalogApi:
    embedder = ConceptEmbedder()
    api.use(
        replace(
            api.deps,
            settings=api.deps.settings.model_copy(update={"nais_internal_token": "s3cret"}),
            demo_search=search_index,
            embedder=embedder,
            query_embedder=embedder,
        )
    )
    return api


def put(api: CatalogApi, documents: list[dict[str, Any]], headers: dict[str, str] | None = TOKEN) -> Any:
    return api.request("PUT", None, "/internal/demo/datasets", json={"documents": documents}, headers=headers)


def find(api: CatalogApi, organization_id: Any, **query: Any) -> dict[str, Any]:
    body = {"viewer": {"organization_id": str(organization_id)}, **query}
    response = api.post(None, "/internal/demo/datasets/search", json=body, headers=TOKEN)
    assert response.status_code == 200, response.text
    result: dict[str, Any] = response.json()
    assert_matches_response("searchDemoDatasets", 200, result)
    return result


def titles(result: dict[str, Any]) -> list[str]:
    return [item["title"] for item in result["items"]]


def test_internal_demo_endpoints_need_the_token(api: CatalogApi, demo_api: CatalogApi) -> None:
    assert put(demo_api, [], headers=None).status_code == 403
    assert put(demo_api, [], headers={"X-NAIS-Internal-Token": "wrong"}).status_code == 403
    # A malformed body without the token is still 403, never a validation error.
    assert demo_api.request("PUT", None, "/internal/demo/datasets", content=b"{").status_code == 403
    demo_api.use(
        replace(demo_api.deps, settings=demo_api.deps.settings.model_copy(update={"nais_internal_token": ""}))
    )
    assert put(demo_api, []).status_code == 404


def test_demo_catalogue_is_searched_by_words_meaning_and_visibility(demo_api: CatalogApi) -> None:
    fuel = make_doc(title="연료전지 스택 운전 로그", owner_organization_id=str(ORG_B))
    climate = make_doc(title="기후 관측 기록", owner_organization_id=str(ORG_B))
    internal = make_doc(title="연료전지 내부 시험", owner_organization_id=str(ORG_B), access_level="INTERNAL")
    response = put(demo_api, [fuel, climate, internal])
    assert response.status_code == 200, response.text
    assert response.json() == {"indexed": 3, "removed": 0}
    assert_matches_response("syncDemoDatasets", 200, response.json())

    assert titles(find(demo_api, ORG_A, q="스택")) == ["연료전지 스택 운전 로그"]
    # By meaning only (no shared word), and INTERNAL stays with its owner organization.
    assert titles(find(demo_api, ORG_A, q="fuel cell")) == ["연료전지 스택 운전 로그"]
    assert set(titles(find(demo_api, ORG_B, q="fuel cell"))) == {
        "연료전지 스택 운전 로그",
        "연료전지 내부 시험",
    }
    everything = find(demo_api, ORG_A)
    assert (
        everything["total"] == 2
        and {"value": "CONTROLLED", "count": 2} in everything["facets"]["access_level"]
    )

    # A second sync replaces the catalogue: what is no longer sent is removed.
    assert put(demo_api, [climate]).json() == {"indexed": 1, "removed": 2}
    assert titles(find(demo_api, ORG_A)) == ["기후 관측 기록"]


def test_demo_documents_must_be_index_documents(demo_api: CatalogApi) -> None:
    assert put(demo_api, [make_doc(storage_url="s3://secret")]).status_code == 422
    assert put(demo_api, [{"dataset_id": str(uuid.uuid4())}]).status_code == 422
    assert demo_api.post(None, "/internal/demo/datasets/search", json={}, headers=TOKEN).status_code == 422
