import os
import statistics
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import date
from typing import Any
from uuid import UUID

import pytest

from api.modules.catalog.search.drain import drain_index_queue
from api.modules.catalog.search.opensearch import OpenSearchIndex
from api.modules.catalog.search.query import SearchParams, map_search_response
from api.modules.catalog.service.search import search_datasets
from api.modules.catalog.tests.support import ORG_A, ORG_B, SHA_A, execute, insert_version, seed_user_id
from api.modules.catalog.tests.support_api import USERS, CatalogApi, assert_error, create_dataset
from api.platform.pagination import encode_cursor
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


def index_now(api: CatalogApi) -> None:
    drain_index_queue(api.deps)
    api.deps.search.refresh()


def published(api: CatalogApi, db: PgUrls, user: str = "b.steward", **overrides: Any) -> str:
    dataset_id: str = create_dataset(api, user, **overrides)["dataset_id"]
    insert_version(db, UUID(dataset_id), published=True, files=[("data/a.csv", 10, SHA_A)])
    execute(
        db, "UPDATE catalog.index_queue SET next_attempt_at = now() WHERE dataset_id = :id", id=dataset_id
    )
    return dataset_id


def search(api: CatalogApi, user: str, **params: Any) -> dict[str, Any]:
    response = api.get(user, "/datasets", params=params)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    assert_matches_response("searchDatasets", 200, body)
    return body


def ids(body: dict[str, Any]) -> set[str]:
    return {item["dataset_id"] for item in body["items"]}


def test_at15_internal_dataset_is_hidden_from_other_orgs(search_api: CatalogApi, db: PgUrls) -> None:
    internal = published(search_api, db, access_level="INTERNAL")
    index_now(search_api)
    assert internal not in ids(search(search_api, "a.researcher"))
    assert internal in ids(search(search_api, "b.researcher"))


def test_at16_published_controlled_dataset_is_discoverable_without_storage_details(
    search_api: CatalogApi, db: PgUrls
) -> None:
    controlled = published(search_api, db)
    index_now(search_api)
    response = search_api.get("a.researcher", "/datasets")
    body = response.json()
    assert_matches_response("searchDatasets", 200, body)
    assert controlled in ids(body)
    assert {"value": "CONTROLLED", "count": 1} in body["facets"]["access_level"]
    hit = next(item for item in body["items"] if item["dataset_id"] == controlled)
    assert hit["owner_organization_name"] == "Institute B" and hit["latest_version_label"] == "v1"
    assert "storage" not in response.text and "http" not in response.text and "datasets/" not in response.text


def test_at17_draft_only_controlled_dataset_is_hidden_from_other_orgs(search_api: CatalogApi) -> None:
    draft_only = create_dataset(search_api)["dataset_id"]
    index_now(search_api)
    assert draft_only not in ids(search(search_api, "a.researcher"))
    assert draft_only in ids(search(search_api, "b.researcher"))


def test_at24_korean_title_is_found_by_a_partial_word(search_api: CatalogApi, db: PgUrls) -> None:
    korean = published(search_api, db, title="고분자 전해질 막 측정")
    published(search_api, db, title="Unrelated battery data")
    index_now(search_api)
    body = search(search_api, "a.researcher", q="전해질")
    assert [item["dataset_id"] for item in body["items"]] == [korean]


def test_withdrawn_datasets_are_not_searchable_even_for_the_owner(search_api: CatalogApi, db: PgUrls) -> None:
    dataset_id = published(search_api, db)
    execute(db, "UPDATE catalog.datasets SET status = 'WITHDRAWN' WHERE dataset_id = :id", id=dataset_id)
    execute(
        db, "INSERT INTO catalog.index_queue (dataset_id) VALUES (:id) ON CONFLICT DO NOTHING", id=dataset_id
    )
    index_now(search_api)
    assert dataset_id not in ids(search(search_api, "b.steward"))


def test_filters_and_facets(search_api: CatalogApi, db: PgUrls) -> None:
    public = published(
        search_api, db, access_level="PUBLIC", allowed_purposes=["EDUCATION"], keywords=["Battery"]
    )
    controlled = published(search_api, db, keywords=["membrane"])
    of_a = published(search_api, db, user="a.steward", access_level="PUBLIC", keywords=["battery"])
    index_now(search_api)
    assert ids(search(search_api, "b.researcher", access_level=["PUBLIC"])) == {public, of_a}
    assert ids(search(search_api, "b.researcher", purpose=["EDUCATION"])) == {public}
    assert ids(search(search_api, "b.researcher", keyword=["BATTERY"])) == {public, of_a}
    assert ids(search(search_api, "b.researcher", owner_organization_id=[str(ORG_A)])) == {of_a}
    assert ids(
        search(
            search_api,
            "b.researcher",
            access_level=["PUBLIC", "CONTROLLED"],
            owner_organization_id=[str(ORG_B)],
        )
    ) == {public, controlled}
    facets = search(search_api, "b.researcher")["facets"]
    owners = {
        bucket["value"]: (bucket.get("label"), bucket["count"]) for bucket in facets["owner_organization_id"]
    }
    assert owners == {str(ORG_B): ("Institute B", 2), str(ORG_A): ("Institute A", 1)}
    assert {"value": "battery", "count": 2} in facets["keyword"]
    assert {"value": "EDUCATION", "count": 1} in facets["purpose"]


def test_readiness_filter(search_api: CatalogApi, db: PgUrls) -> None:
    dataset_id = published(search_api, db)
    version_id = search_api.get("b.steward", f"/datasets/{dataset_id}").json()["latest_published_version"][
        "dataset_version_id"
    ]
    execute(
        db,
        "INSERT INTO catalog.readiness_summaries (dataset_version_id, profile_id, dataset_id, validation_id, run_status,"
        " overall_status, completed_at, source_event_id) VALUES (:v, 'TABULAR_ML_BASIC', :d, gen_random_uuid(),"
        " 'COMPLETED', 'FAIL', now(), gen_random_uuid())",
        v=version_id,
        d=dataset_id,
    )
    published(search_api, db)
    index_now(search_api)
    body = search(search_api, "a.researcher", readiness_status=["FAIL"])
    assert ids(body) == {dataset_id}
    assert body["items"][0]["readiness_overall"] == "FAIL"
    assert {"value": "FAIL", "count": 1} in search(search_api, "a.researcher")["facets"]["readiness_status"]


def test_cursor_pagination_without_duplicates(search_api: CatalogApi, db: PgUrls) -> None:
    created = {published(search_api, db, title=f"Dataset {n}") for n in range(3)}
    index_now(search_api)
    first = search(search_api, "a.researcher", limit=2, sort="title_asc")
    assert [item["title"] for item in first["items"]] == ["Dataset 0", "Dataset 1"]
    assert first["page"]["has_more"] is True and first["total"] == 3
    second = search(
        search_api, "a.researcher", limit=2, sort="title_asc", cursor=first["page"]["next_cursor"]
    )
    assert [item["title"] for item in second["items"]] == ["Dataset 2"]
    assert second["page"] == {"next_cursor": None, "has_more": False}
    assert ids(first) | ids(second) == created


def test_default_order_is_most_recently_updated(search_api: CatalogApi, db: PgUrls) -> None:
    older = published(search_api, db, title="Older dataset")
    newer = published(search_api, db, title="Newer dataset")
    index_now(search_api)
    assert [item["dataset_id"] for item in search(search_api, "a.researcher")["items"]] == [newer, older]


def test_cursor_from_another_sort_is_rejected(search_api: CatalogApi, db: PgUrls) -> None:  # Review Focus 2
    published(search_api, db)
    published(search_api, db)
    index_now(search_api)
    cursor = search(search_api, "a.researcher", limit=1, sort="title_asc")["page"]["next_cursor"]
    assert_error(
        "searchDatasets",
        search_api.get("a.researcher", "/datasets", params={"cursor": cursor, "sort": "updated_desc"}),
        422,
        "VALIDATION_FAILED",
    )


@pytest.mark.parametrize(
    "cursor",
    [
        "%%%",
        "bm90LWpzb24",
        encode_cursor(["title_asc", "x", "y", "z"]),
        encode_cursor(["title_asc", {"a": 1}, "b"]),
    ],
)
def test_garbage_cursor_is_rejected(search_api: CatalogApi, cursor: str) -> None:  # Review Focus 2
    response = search_api.get("a.researcher", "/datasets", params={"cursor": cursor, "sort": "title_asc"})
    error = assert_error("searchDatasets", response, 422, "VALIDATION_FAILED")
    assert error["details"]["fields"] == [{"field": "cursor", "reason": "INVALID_CURSOR"}]


def test_platform_admin_sees_internal_datasets_but_not_withdrawn(search_api: CatalogApi, db: PgUrls) -> None:
    internal = published(search_api, db, access_level="INTERNAL")
    draft_only = create_dataset(search_api)["dataset_id"]
    withdrawn = published(search_api, db)
    execute(db, "UPDATE catalog.datasets SET status = 'WITHDRAWN' WHERE dataset_id = :id", id=withdrawn)
    execute(
        db, "INSERT INTO catalog.index_queue (dataset_id) VALUES (:id) ON CONFLICT DO NOTHING", id=withdrawn
    )
    index_now(search_api)
    assert {internal, draft_only} <= ids(search(search_api, "platform.admin"))
    assert withdrawn not in ids(search(search_api, "platform.admin"))


def test_search_visibility_matches_can_see_dataset_for_active_datasets(
    search_api: CatalogApi, db: PgUrls
) -> None:
    from api.modules.catalog.access import can_see_dataset
    from api.modules.catalog.repo import load_dataset

    created = [
        published(search_api, db, access_level="INTERNAL"),
        published(search_api, db, access_level="PUBLIC"),
        published(search_api, db, access_level="SENSITIVE"),
        create_dataset(search_api, "b.steward", access_level="PUBLIC")["dataset_id"],
        create_dataset(search_api, "a.steward", access_level="INTERNAL")["dataset_id"],
    ]
    index_now(search_api)
    for name, user in USERS.items():
        found = ids(search(search_api, name))
        for dataset_id in created:
            with search_api.deps.session_factory() as session:
                row = load_dataset(session, UUID(dataset_id))
            assert row is not None
            assert (dataset_id in found) == can_see_dataset(user, row), (name, dataset_id)


def test_documents_use_only_mapped_fields_and_cover_the_query_fields(
    search_api: CatalogApi, db: PgUrls
) -> None:
    from api.modules.catalog.search.documents import build_documents
    from api.modules.catalog.search.index_body import MAPPINGS
    from api.modules.catalog.search.query import AGGREGATIONS, HIT_FIELDS, SEARCH_FIELDS, SORTS

    dataset_id = published(search_api, db, keywords=["x"])
    with search_api.deps.session_factory() as session:
        docs, _ = build_documents(session, search_api.deps.organizations, [UUID(dataset_id)])
    mapped = set(MAPPINGS["properties"])
    assert set(docs[0]) == mapped
    body = build_search_body_for_keys()
    used = {agg["terms"]["field"] for agg in AGGREGATIONS.values()} | {"status", "has_published_version"}
    used |= {field for clause in body for field in clause}
    used |= {field.split("^")[0] for field in SEARCH_FIELDS} | set(HIT_FIELDS)
    assert {
        field.split(".")[0]
        for field in used | {key for s in SORTS.values() for d in s for key in d} - {"_score"}
    } <= mapped


def build_search_body_for_keys() -> list[set[str]]:
    from api.modules.catalog.search.query import build_search_body

    params = SearchParams(
        q="x",
        access_level=("PUBLIC",),
        owner_organization_id=(ORG_A,),
        purpose=("EDUCATION",),
        keyword=("k",),
        readiness_status=("FAIL",),
        subject=("MATERIALS",),
        material=("CATHODE",),
        method=("XRD",),
        collecting_organization_id=(ORG_B,),
        principal_investigator_id=ORG_A,
        temporal_from=date(2025, 1, 1),
        temporal_to=date(2025, 12, 31),
    )
    body = build_search_body(USERS["a.researcher"], params, "relevance", None)
    fields: set[str] = set()

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                if key in ("term", "terms", "range") and isinstance(value, dict):
                    fields.update(value)
                if key == "exists":
                    fields.add(value["field"])
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(body["query"])
    return [fields]


def test_opensearch_outage_is_503(api: CatalogApi) -> None:
    api.use(replace(api.deps, search=OpenSearchIndex("http://127.0.0.1:9", "nais-datasets", timeout=0.5)))
    response = api.get("a.researcher", "/datasets")
    assert_error("searchDatasets", response, 503, "DEPENDENCY_UNAVAILABLE")
    assert "127.0.0.1" not in response.text


def test_search_requires_authentication(api: CatalogApi) -> None:
    assert_error("searchDatasets", api.get(None, "/datasets"), 401, "UNAUTHENTICATED")


def test_total_is_capped_at_10000() -> None:
    raw = {"hits": {"total": {"value": 25000, "relation": "gte"}, "hits": []}, "aggregations": {}}
    assert map_search_response(raw, limit=20, sort_name="updated_desc")["total"] == 10000


@pytest.mark.skipif(
    os.environ.get("NAIS_PERF") != "1", reason="set NAIS_PERF=1 to run the 10k-document load test"
)
def test_at20_p95_under_1_5_seconds_with_10k_docs(search_index: OpenSearchIndex) -> None:  # M03-AT-20
    from api.modules.catalog.adapters.identity import FakeIdentityPort
    from api.modules.catalog.adapters.malware import NoopScanner
    from api.modules.catalog.deps import CatalogDeps
    from api.modules.catalog.settings import CatalogSettings
    from api.modules.catalog.testing import RecordingVerificationQueue, memory_registry

    words = ["battery", "membrane", "sensor", "polymer", "catalyst", "전해질", "고분자", "측정"]
    for start in range(0, 10_000, 1000):
        docs = [
            {
                "dataset_id": str(uuid.uuid4()),
                "title": f"{words[n % 8]} dataset {n}",
                "description": " ".join(words[(n + k) % 8] for k in range(20)),
                "snippet": "",
                "keywords": [words[n % 8], words[(n + 3) % 8]],
                "domain": "materials",
                "access_level": ["PUBLIC", "INTERNAL", "CONTROLLED", "SENSITIVE"][n % 4],
                "owner_organization_id": str([ORG_A, ORG_B][n % 2]),
                "owner_organization_name": ["Institute A", "Institute B"][n % 2],
                "allowed_purposes": ["ACADEMIC_RESEARCH"],
                "license": "CC-BY-4.0",
                "status": "ACTIVE",
                "has_published_version": n % 5 != 0,
                "latest_version_id": None,
                "latest_version_label": "v1",
                "readiness_overall": ["PASS", "WARNING", "FAIL", None][n % 4],
                "published_at": None,
                "updated_at": "2026-10-01T00:00:00+00:00",
            }
            for n in range(start, start + 1000)
        ]
        search_index.bulk(docs, [])
    search_index.refresh()
    deps = CatalogDeps(
        settings=CatalogSettings(),
        session_factory=lambda: None,  # type: ignore[arg-type,return-value]
        storage=memory_registry(),
        organizations=FakeIdentityPort(),
        scanner=NoopScanner(),
        verification=RecordingVerificationQueue(),
        search=search_index,
    )
    user = USERS["a.researcher"]
    queries = [
        SearchParams(q=words[n % 8], keyword=(words[(n + 1) % 8],) if n % 3 == 0 else ()) for n in range(200)
    ]

    def timed(params: SearchParams) -> float:
        started = time.perf_counter()
        search_datasets(deps, user, params)
        return time.perf_counter() - started

    with ThreadPoolExecutor(max_workers=50) as pool:
        latencies = sorted(pool.map(timed, queries))
    p95 = statistics.quantiles(latencies, n=20)[18]
    assert p95 < 1.5, f"p95={p95:.3f}s"


def test_facets_never_count_what_the_user_cannot_see(search_api: CatalogApi, db: PgUrls) -> None:
    internal = published(search_api, db, access_level="INTERNAL", keywords=["secretkw"])
    draft_only = create_dataset(search_api, "b.steward", keywords=["draftkw"])["dataset_id"]
    controlled = published(search_api, db, keywords=["openkw"])
    own = published(search_api, db, user="a.steward", access_level="PUBLIC", keywords=["ownkw"])
    index_now(search_api)
    body = search(search_api, "a.researcher")
    assert ids(body) == {controlled, own}
    assert internal not in ids(body) and draft_only not in ids(body)
    facets = body["facets"]
    assert {b["value"]: b["count"] for b in facets["owner_organization_id"]} == {str(ORG_B): 1, str(ORG_A): 1}
    assert {b["value"] for b in facets["keyword"]} == {"openkw", "ownkw"}
    levels = {b["value"]: b["count"] for b in facets["access_level"]}
    assert levels == {"CONTROLLED": 1, "PUBLIC": 1}


def test_filters_cannot_widen_visibility(search_api: CatalogApi, db: PgUrls) -> None:
    published(search_api, db, access_level="INTERNAL")
    create_dataset(search_api, "b.steward")  # draft-only
    index_now(search_api)
    for params in ({"access_level": ["INTERNAL"]}, {"owner_organization_id": [str(ORG_B)]}):
        body = search(search_api, "a.researcher", **params)
        assert body["total"] == 0 and body["items"] == []
        assert all(buckets == [] for buckets in body["facets"].values()), params


def test_temporal_overlap_includes_open_ended(search_api: CatalogApi, db: PgUrls) -> None:  # Review Focus 4
    old = published(
        search_api, db, title="Old period", temporal_start="2024-01-01", temporal_end="2025-12-31"
    )
    ongoing = published(search_api, db, title="Ongoing", temporal_start="2025-07-01")
    undated = published(search_api, db, title="Undated")
    future = published(search_api, db, title="Future", temporal_start="2025-09-01")
    index_now(search_api)
    found = ids(search(search_api, "b.researcher", temporal_from="2026-01-01"))
    assert ongoing in found and future in found and old not in found and undated not in found
    window = ids(search(search_api, "b.researcher", temporal_from="2025-01-01", temporal_to="2025-08-01"))
    assert window == {old, ongoing}
    assert ids(search(search_api, "b.researcher", temporal_to="2024-06-30")) == {old}


def test_inverted_temporal_range_is_422(search_api: CatalogApi) -> None:  # Review Focus 4
    response = search_api.get(
        "b.researcher", "/datasets", params={"temporal_from": "2026-01-02", "temporal_to": "2026-01-01"}
    )
    error = assert_error("searchDatasets", response, 422, "VALIDATION_FAILED")
    assert error["details"]["fields"] == [{"field": "temporal_to", "reason": "TEMPORAL_RANGE"}]


def test_subject_and_collecting_org_filters_and_facets(search_api: CatalogApi, db: PgUrls) -> None:
    mat = published(
        search_api,
        db,
        title="Mat",
        subtitle="Cathode study",
        subject_codes=["MATERIALS"],
        collecting_organization_id=str(ORG_B),
    )
    published(search_api, db, title="Energy", subject_codes=["ENERGY"])
    index_now(search_api)
    result = search(search_api, "b.researcher", subject=["MATERIALS"])
    assert [h["dataset_id"] for h in result["items"]] == [mat]
    hit = result["items"][0]
    assert hit["subject_codes"] == ["MATERIALS"]
    assert hit["principal_investigator_name"] == "B Researcher"
    assert hit["subtitle"] == "Cathode study" and hit["collecting_organization_name"] == "Institute B"
    assert ids(search(search_api, "b.researcher", collecting_organization_id=[str(ORG_B)])) == {mat}
    assert ids(search(search_api, "b.researcher", collecting_organization_id=[str(ORG_A)])) == set()
    facets = search(search_api, "b.researcher")["facets"]
    assert {"value": "MATERIALS", "count": 1, "label": "재료"} in facets["subject"]
    assert {"value": "ENERGY", "count": 1, "label": "에너지"} in facets["subject"]
    assert {"value": str(ORG_B), "count": 1, "label": "Institute B"} in facets["collecting_organization_id"]


def test_material_and_method_filters_and_facets(search_api: CatalogApi, db: PgUrls) -> None:  # Ruling P13
    both = published(search_api, db, material_codes=["CATHODE", "ELECTROLYTE"], method_codes=["XRD"])
    cathode = published(search_api, db, material_codes=["CATHODE"], method_codes=["SEM"])
    published(search_api, db)
    index_now(search_api)
    assert ids(search(search_api, "b.researcher", material=["CATHODE"])) == {both, cathode}
    assert ids(search(search_api, "b.researcher", material=["ELECTROLYTE", "ANODE"])) == {both}
    assert ids(search(search_api, "b.researcher", method=["SEM"])) == {cathode}
    assert ids(search(search_api, "b.researcher", material=["CATHODE"], method=["XRD"])) == {both}
    facets = search(search_api, "b.researcher")["facets"]
    assert {"value": "CATHODE", "count": 2, "label": "양극재"} in facets["material"]
    assert {"value": "XRD", "count": 1, "label": "X선 회절(XRD)"} in facets["method"]
    assert ids(search(search_api, "b.researcher", q="양극재")) == {both, cathode}


def test_pi_filter_and_korean_label_query(search_api: CatalogApi, db: PgUrls) -> None:
    mine = published(search_api, db, title="PI dataset", subject_codes=["MATERIALS"])
    published(search_api, db, title="Other PI", principal_investigator_id=str(seed_user_id("0b03")))
    index_now(search_api)
    by_pi = search(search_api, "b.researcher", principal_investigator_id=str(seed_user_id("0b02")))
    assert [h["dataset_id"] for h in by_pi["items"]] == [mine]
    assert mine in ids(search(search_api, "b.researcher", q="재료"))
    assert mine in ids(search(search_api, "b.researcher", q="B Researcher"))


def test_search_hits_never_contain_person_emails(search_api: CatalogApi, db: PgUrls) -> None:  # Focus 5
    published(search_api, db, contact_email="lab@example.org", contact_email_public=True)
    index_now(search_api)
    response = search_api.get("b.researcher", "/datasets")
    assert response.status_code == 200 and response.json()["items"]
    assert "@" not in response.text


def test_facet_filters_cannot_widen_visibility(search_api: CatalogApi, db: PgUrls) -> None:  # D-012
    published(
        search_api, db, access_level="INTERNAL", subject_codes=["MATERIALS"], temporal_start="2025-01-01"
    )
    index_now(search_api)
    for params in (
        {"subject": ["MATERIALS"]},
        {"temporal_from": "2024-01-01"},
        {"principal_investigator_id": str(seed_user_id("0b02"))},
    ):
        body = search(search_api, "a.researcher", **params)
        assert body["total"] == 0 and all(buckets == [] for buckets in body["facets"].values()), params


class ConceptEmbedder:
    """Embedding double: texts about the same concept (in either language) get the same unit vector."""

    CONCEPTS = (("연료전지", "fuel cell"), ("기후", "climate"))

    def __init__(self) -> None:
        self.calls = 0

    def embed(self, texts: list[str]) -> list[list[float]]:
        from api.platform.search_index import EMBEDDING_DIMENSION

        self.calls += 1
        vectors = []
        for text in texts:
            vector = [0.0] * EMBEDDING_DIMENSION
            lowered = text.lower()
            axis = next(
                (i for i, words in enumerate(self.CONCEPTS) if any(word in lowered for word in words)),
                len(self.CONCEPTS),
            )
            vector[axis] = 1.0
            vectors.append(vector)
        return vectors


class BrokenEmbedder:
    def embed(self, texts: list[str]) -> list[list[float]]:
        raise RuntimeError("embedding server down")


def test_text_search_also_finds_datasets_by_meaning(search_api: CatalogApi, db: PgUrls) -> None:
    embedder = ConceptEmbedder()
    search_api.use(replace(search_api.deps, embedder=embedder, query_embedder=embedder))
    korean = published(search_api, db, title="연료전지 막 온도 측정")
    climate = published(search_api, db, title="기후 관측 기록")
    index_now(search_api)
    # No word in common with the Korean title: only the embedding connects them.
    assert [item["dataset_id"] for item in search(search_api, "a.researcher", q="fuel cell")["items"]] == [
        korean
    ]
    assert ids(search(search_api, "a.researcher", q="climate")) == {climate}
    assert ids(search(search_api, "a.researcher", q="quantum")) == set()


def test_semantic_search_keeps_the_visibility_filter(search_api: CatalogApi, db: PgUrls) -> None:
    embedder = ConceptEmbedder()
    search_api.use(replace(search_api.deps, embedder=embedder, query_embedder=embedder))
    internal = published(search_api, db, title="연료전지 내부 시험", access_level="INTERNAL")
    index_now(search_api)
    assert ids(search(search_api, "a.researcher", q="fuel cell")) == set()
    assert ids(search(search_api, "b.researcher", q="fuel cell")) == {internal}


def test_search_is_lexical_when_the_embedding_server_is_down(search_api: CatalogApi, db: PgUrls) -> None:
    search_api.use(replace(search_api.deps, embedder=BrokenEmbedder(), query_embedder=BrokenEmbedder()))
    dataset_id = published(search_api, db, title="연료전지 막 온도 측정")
    index_now(search_api)
    assert ids(search(search_api, "a.researcher", q="연료전지")) == {dataset_id}
    assert ids(search(search_api, "a.researcher", q="fuel cell")) == set()


def test_text_search_snippet_is_the_matching_passage(search_api: CatalogApi, db: PgUrls) -> None:
    description = "서두 문장입니다. " * 40 + "이 부분에 임피던스 분광 결과가 있습니다."
    dataset_id = published(search_api, db, description=description)
    index_now(search_api)
    hit = next(
        i for i in search(search_api, "a.researcher", q="임피던스")["items"] if i["dataset_id"] == dataset_id
    )
    assert "임피던스" in hit["snippet"] and len(hit["snippet"]) < len(description)
    plain = next(i for i in search(search_api, "a.researcher")["items"] if i["dataset_id"] == dataset_id)
    assert plain["snippet"] == description[:300]
