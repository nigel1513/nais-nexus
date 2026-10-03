import json
import os
import uuid
from typing import Any

import httpx
import pytest

from api.modules.catalog.search.index_body import index_body
from api.modules.catalog.search.opensearch import OpenSearchIndex, SearchRejected, SearchUnavailable
from api.platform.settings import REPO_ROOT

INFRA = REPO_ROOT / "infra" / "opensearch"


def make_doc(**overrides: Any) -> dict[str, Any]:
    doc: dict[str, Any] = {
        "dataset_id": str(uuid.uuid4()),
        "title": "Battery Cycling Measurements",
        "description": "Cycling data",
        "snippet": "Cycling data",
        "keywords": ["battery"],
        "domain": "materials",
        "access_level": "CONTROLLED",
        "owner_organization_id": str(uuid.uuid4()),
        "owner_organization_name": "Institute B",
        "allowed_purposes": ["ACADEMIC_RESEARCH"],
        "license": "CC-BY-4.0",
        "status": "ACTIVE",
        "has_published_version": True,
        "latest_version_id": str(uuid.uuid4()),
        "latest_version_label": "v1",
        "readiness_overall": None,
        "published_at": "2026-10-01T00:00:00+00:00",
        "updated_at": "2026-10-01T00:00:00+00:00",
        "subtitle": None,
        "subject_codes": [],
        "material_codes": [],
        "method_codes": [],
        "subject_labels": "",
        "temporal_start": None,
        "temporal_end": None,
        "collecting_organization_id": None,
        "collecting_organization_name": None,
        "principal_investigator_id": None,
        "principal_investigator_name": None,
    }
    doc.update(overrides)
    return doc


def test_infra_templates_match_the_code() -> None:
    assert json.loads((INFRA / "nais-datasets-v3.json").read_text(encoding="utf-8")) == index_body(nori=True)
    assert json.loads((INFRA / "nais-datasets-v3.fallback.json").read_text(encoding="utf-8")) == index_body(
        nori=False
    )
    assert "analysis-nori" in (INFRA / "Dockerfile").read_text(encoding="utf-8")


def test_ensure_creates_versioned_index_behind_alias_with_fallback_analyzer(
    search_index: OpenSearchIndex, opensearch_url: str
) -> None:
    search_index.ensure()
    concrete = f"{search_index.alias}-v3"
    assert list(httpx.get(f"{opensearch_url}/_alias/{search_index.alias}").json()) == [concrete]
    settings = httpx.get(f"{opensearch_url}/{concrete}/_settings").json()[concrete]["settings"]["index"]
    assert settings["analysis"]["analyzer"]["ko_en"]["tokenizer"] == "standard"  # stock image has no nori
    search_index.ensure()
    OpenSearchIndex(opensearch_url, search_index.alias).ensure()  # second process: no error, no new index
    assert list(httpx.get(f"{opensearch_url}/_alias/{search_index.alias}").json()) == [concrete]


def test_korean_title_matches_a_partial_word(
    search_index: OpenSearchIndex,
) -> None:  # M03-AT-24 (index level)
    doc = make_doc(title="고분자 전해질 막 측정")
    search_index.bulk([doc, make_doc(title="Unrelated")], [])
    search_index.refresh()
    result = search_index.search({"query": {"multi_match": {"query": "전해질", "fields": ["title^3"]}}})
    assert [hit["_id"] for hit in result["hits"]["hits"]] == [doc["dataset_id"]]


def test_bulk_upserts_and_deletes(search_index: OpenSearchIndex) -> None:
    doc = make_doc()
    search_index.bulk([doc], [])
    search_index.bulk([{**doc, "title": "Renamed"}], [str(uuid.uuid4())])  # deleting an unknown id is fine
    search_index.refresh()
    hits = search_index.search({"query": {"ids": {"values": [doc["dataset_id"]]}}})["hits"]["hits"]
    assert [h["_source"]["title"] for h in hits] == ["Renamed"]
    search_index.bulk([], [doc["dataset_id"]])
    search_index.refresh()
    assert search_index.search({"query": {"match_all": {}}})["hits"]["hits"] == []


def test_strict_mapping_rejects_unknown_fields(search_index: OpenSearchIndex) -> None:
    with pytest.raises(SearchUnavailable, match="failures"):
        search_index.bulk([make_doc(unexpected="x")], [])


def test_bad_search_after_is_rejected(search_index: OpenSearchIndex) -> None:
    search_index.ensure()
    with pytest.raises(SearchRejected):
        search_index.search(
            {"query": {"match_all": {}}, "sort": [{"dataset_id": "asc"}], "search_after": ["a", "b", "c"]}
        )


def test_unreachable_cluster_raises_search_unavailable() -> None:
    with pytest.raises(SearchUnavailable):
        OpenSearchIndex("http://127.0.0.1:9", "nais-datasets", timeout=0.5).search(
            {"query": {"match_all": {}}}
        )


def test_credentials_in_the_url_become_basic_auth() -> None:
    index = OpenSearchIndex("http://nais:secret@localhost:21056/", "nais-datasets")
    assert index._client.auth is not None
    assert str(index._client.base_url).rstrip("/") == "http://localhost:21056"


def test_next_index_name_and_atomic_alias_swap(search_index: OpenSearchIndex, opensearch_url: str) -> None:
    search_index.ensure()
    assert search_index.next_index_name() == f"{search_index.alias}-v4"
    search_index.create_index(f"{search_index.alias}-v4")
    assert search_index.swap_alias(f"{search_index.alias}-v4") == [f"{search_index.alias}-v3"]
    assert list(httpx.get(f"{opensearch_url}/_alias/{search_index.alias}").json()) == [
        f"{search_index.alias}-v4"
    ]
    assert search_index.next_index_name() == f"{search_index.alias}-v5"


@pytest.mark.skipif(
    os.environ.get("NAIS_TEST_NORI") != "1", reason="set NAIS_TEST_NORI=1 to build infra/opensearch"
)
def test_nori_image_uses_the_nori_analyzer() -> None:
    from testcontainers.core.image import DockerImage

    from api.modules.catalog.tests.fixtures_search import start_opensearch

    with DockerImage(path=str(INFRA), tag="nais/opensearch-nori:test"):
        container, url = start_opensearch("nais/opensearch-nori:test")
        try:
            index = OpenSearchIndex(url, "nori-check")
            assert index.nori_available()
            index.ensure()
            analyzer = httpx.get(f"{url}/nori-check-v2/_settings").json()["nori-check-v2"]["settings"][
                "index"
            ]
            assert analyzer["analysis"]["analyzer"]["ko_en"]["tokenizer"] == "nori_mixed"
            doc = make_doc(title="고분자 전해질 막 측정")
            index.bulk([doc], [])
            index.refresh()
            hits = index.search({"query": {"multi_match": {"query": "전해질", "fields": ["title^3"]}}})
            assert [h["_id"] for h in hits["hits"]["hits"]] == [doc["dataset_id"]]
        finally:
            container.stop()  # type: ignore[attr-defined]
