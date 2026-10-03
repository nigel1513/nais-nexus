"""searchDatasets query DSL (M03 §6.2). Visibility is a query filter, never a post-filter (D-012)."""

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import date
from typing import Any, Protocol
from uuid import UUID

from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.pagination import decode_cursor, encode_cursor
from api.platform.search_index import EMBEDDING_FIELD

MAX_TOTAL = 10_000
DISCOVERABLE_LEVELS = ["PUBLIC", "CONTROLLED", "SENSITIVE"]
SORTS: dict[str, list[dict[str, str]]] = {
    "relevance": [{"_score": "desc"}, {"dataset_id": "asc"}],
    "updated_desc": [{"updated_at": "desc"}, {"dataset_id": "asc"}],
    "title_asc": [{"title.raw": "asc"}, {"dataset_id": "asc"}],
}
SEARCH_FIELDS = [
    "title^3",
    "keywords.text^2",
    "description",
    "owner_organization_name.text",
    "subtitle^2",
    "subject_labels",
    "principal_investigator_name.text",
    "collecting_organization_name.text",
]
# The semantic clause scores 0.5-1 (cosine), BM25 a few points per matching field: the boost keeps a document that
# only matches by meaning below one that also contains the words, and above nothing.
SEMANTIC_BOOST = 4.0
SNIPPET_FRAGMENT_CHARS = 200
VOCABULARY_FACETS = {"subject": "SUBJECT", "material": "MATERIAL", "method": "METHOD"}
AGGREGATIONS: dict[str, Any] = {
    "access_level": {"terms": {"field": "access_level", "size": 4}},
    "owner_organization_id": {
        "terms": {"field": "owner_organization_id", "size": 50},
        "aggs": {"name": {"terms": {"field": "owner_organization_name", "size": 1}}},
    },
    "purpose": {"terms": {"field": "allowed_purposes", "size": 5}},
    "keyword": {"terms": {"field": "keywords", "size": 20}},
    "readiness_status": {"terms": {"field": "readiness_overall", "size": 3}},
    "subject": {"terms": {"field": "subject_codes", "size": 30}},
    "material": {"terms": {"field": "material_codes", "size": 30}},
    "method": {"terms": {"field": "method_codes", "size": 30}},
    "collecting_organization_id": {
        "terms": {"field": "collecting_organization_id", "size": 50},
        "aggs": {"name": {"terms": {"field": "collecting_organization_name", "size": 1}}},
    },
}
HIT_FIELDS = (
    "dataset_id",
    "title",
    "snippet",
    "owner_organization_id",
    "owner_organization_name",
    "access_level",
    "keywords",
    "allowed_purposes",
    "latest_version_label",
    "readiness_overall",
    "updated_at",
    "subtitle",
    "principal_investigator_name",
    "temporal_start",
    "temporal_end",
    "subject_codes",
    "collecting_organization_name",
)


@dataclass(frozen=True)
class SearchParams:
    q: str | None = None
    access_level: tuple[str, ...] = ()
    owner_organization_id: tuple[UUID, ...] = ()
    purpose: tuple[str, ...] = ()
    keyword: tuple[str, ...] = ()
    readiness_status: tuple[str, ...] = ()
    subject: tuple[str, ...] = ()
    material: tuple[str, ...] = ()
    method: tuple[str, ...] = ()
    collecting_organization_id: tuple[UUID, ...] = ()
    principal_investigator_id: UUID | None = None
    temporal_from: date | None = None
    temporal_to: date | None = None
    sort: str = "relevance"
    cursor: str | None = None
    limit: int = 20


def invalid_cursor() -> ApiError:
    return ApiError(
        ErrorCode.VALIDATION_FAILED,
        "Invalid pagination cursor.",
        {"fields": [{"field": "cursor", "reason": "INVALID_CURSOR"}]},
    )


def resolve_sort(params: SearchParams) -> str:
    if params.sort == "relevance" and not (params.q and params.q.strip()):
        return "updated_desc"
    return params.sort


def decode_search_cursor(cursor: str, sort_name: str) -> list[Any]:
    values = decode_cursor(cursor)
    if (
        len(values) != 3
        or values[0] != sort_name
        or not all(isinstance(v, str | int | float) for v in values[1:])
    ):
        raise invalid_cursor()
    return values[1:]


class Viewer(Protocol):
    """Who is searching: CurrentUser, or the demo viewer of the mock-mode web server."""

    @property
    def organization_id(self) -> UUID: ...
    @property
    def is_platform_admin(self) -> bool: ...


def visibility_filter(user: Viewer) -> dict[str, Any]:
    """Same rule as access.can_see_dataset, restricted to ACTIVE datasets (status is filtered separately)."""
    if user.is_platform_admin:
        return {"match_all": {}}
    return {
        "bool": {
            "should": [
                {
                    "bool": {
                        "filter": [
                            {"terms": {"access_level": DISCOVERABLE_LEVELS}},
                            {"term": {"has_published_version": True}},
                        ]
                    }
                },
                {"term": {"owner_organization_id": str(user.organization_id)}},
            ],
            "minimum_should_match": 1,
        }
    }


def _temporal_filters(params: SearchParams) -> list[dict[str, Any]]:
    """Period overlap: undated datasets never match; a missing temporal_end is open-ended (ongoing)."""
    if not (params.temporal_from or params.temporal_to):
        return []
    filters: list[dict[str, Any]] = [{"exists": {"field": "temporal_start"}}]
    if params.temporal_to:
        filters.append({"range": {"temporal_start": {"lte": params.temporal_to.isoformat()}}})
    if params.temporal_from:
        filters.append(
            {
                "bool": {
                    "should": [
                        {"range": {"temporal_end": {"gte": params.temporal_from.isoformat()}}},
                        {"bool": {"must_not": {"exists": {"field": "temporal_end"}}}},
                    ],
                    "minimum_should_match": 1,
                }
            }
        )
    return filters


def text_query(q: str, fields: list[str], vector: list[float] | None, min_score: float) -> dict[str, Any]:
    """Hybrid match: the words (BM25 over the analyzed metadata fields) or the meaning (k-NN over the document
    embedding, only neighbours at least `min_score` close). Without a query vector it is the lexical half alone."""
    lexical: dict[str, Any] = {"multi_match": {"query": q, "fields": fields}}
    if vector is None:
        return lexical
    semantic = {"knn": {EMBEDDING_FIELD: {"vector": vector, "min_score": min_score, "boost": SEMANTIC_BOOST}}}
    return {"bool": {"should": [lexical, semantic], "minimum_should_match": 1}}


def build_search_body(
    user: Viewer,
    params: SearchParams,
    sort_name: str,
    search_after: list[Any] | None,
    *,
    vector: list[float] | None = None,
    min_score: float = 0.76,
) -> dict[str, Any]:
    filters: list[dict[str, Any]] = [{"term": {"status": "ACTIVE"}}, visibility_filter(user)]
    if params.access_level:
        filters.append({"terms": {"access_level": list(params.access_level)}})
    if params.owner_organization_id:
        filters.append({"terms": {"owner_organization_id": [str(o) for o in params.owner_organization_id]}})
    if params.purpose:
        filters.append({"terms": {"allowed_purposes": list(params.purpose)}})
    if params.keyword:
        filters.append({"terms": {"keywords": [k.strip().lower() for k in params.keyword]}})
    if params.readiness_status:
        filters.append({"terms": {"readiness_overall": list(params.readiness_status)}})
    for field, values in (
        ("subject_codes", params.subject),
        ("material_codes", params.material),
        ("method_codes", params.method),
    ):
        if values:
            filters.append({"terms": {field: list(values)}})
    if params.collecting_organization_id:
        filters.append(
            {"terms": {"collecting_organization_id": [str(o) for o in params.collecting_organization_id]}}
        )
    if params.principal_investigator_id:
        filters.append({"term": {"principal_investigator_id": str(params.principal_investigator_id)}})
    filters.extend(_temporal_filters(params))
    query: dict[str, Any] = {"bool": {"filter": filters}}
    if params.q and params.q.strip():
        query["bool"]["must"] = [text_query(params.q.strip(), SEARCH_FIELDS, vector, min_score)]
    body: dict[str, Any] = {
        "query": query,
        "size": params.limit + 1,
        "sort": SORTS[sort_name],
        "track_total_hits": MAX_TOTAL,
        "aggs": AGGREGATIONS,
        "_source": list(HIT_FIELDS),
    }
    if params.q and params.q.strip():
        # The snippet of a text search is the passage of the description that matched, not its first lines.
        body["highlight"] = {
            "pre_tags": [""],
            "post_tags": [""],
            "fields": {"description": {"fragment_size": SNIPPET_FRAGMENT_CHARS, "number_of_fragments": 1}},
        }
    if search_after is not None:
        body["search_after"] = search_after
    return body


def _buckets(aggregations: Mapping[Any, Any], name: str) -> list[dict[str, Any]]:
    return [
        {"value": str(bucket["key"]), "count": int(bucket["doc_count"])}
        for bucket in aggregations.get(name, {}).get("buckets", [])
    ]


def _named_buckets(aggregations: Mapping[Any, Any], name: str) -> list[dict[str, Any]]:
    buckets = []
    for bucket in aggregations.get(name, {}).get("buckets", []):
        item: dict[str, Any] = {"value": str(bucket["key"]), "count": int(bucket["doc_count"])}
        names = bucket.get("name", {}).get("buckets", [])
        if names and names[0]["key"]:
            item["label"] = str(names[0]["key"])
        buckets.append(item)
    return buckets


def _hit(source: Mapping[Any, Any], highlight: Mapping[Any, Any] | None = None) -> dict[str, Any]:
    hit = {field: source.get(field) for field in HIT_FIELDS}
    if fragments := (highlight or {}).get("description"):
        hit["snippet"] = str(fragments[0]).strip()
    if not hit["owner_organization_name"]:
        hit.pop("owner_organization_name")
    if hit["snippet"] is None:
        hit.pop("snippet")
    hit["keywords"] = list(hit["keywords"] or [])
    hit["allowed_purposes"] = list(hit["allowed_purposes"] or [])
    hit["subject_codes"] = list(hit["subject_codes"] or [])
    return hit


def label_vocabulary_facets(
    facets: dict[str, list[dict[str, Any]]], labels_for: Callable[[str, list[str]], Mapping[str, str]]
) -> None:
    """Facet labels for vocabulary codes are the Korean labels (label_ko), resolved from the catalog DB."""
    for name, scheme in VOCABULARY_FACETS.items():
        buckets = facets.get(name) or []
        if not buckets:
            continue
        found = labels_for(scheme, [bucket["value"] for bucket in buckets])
        for bucket in buckets:
            if label := found.get(bucket["value"]):
                bucket["label"] = label


def map_search_response(raw: Mapping[Any, Any], *, limit: int, sort_name: str) -> dict[str, Any]:
    hits = raw["hits"]["hits"]
    page_hits = hits[:limit]
    has_more = len(hits) > limit
    next_cursor = encode_cursor([sort_name, *page_hits[-1]["sort"]]) if has_more and page_hits else None
    aggregations = raw.get("aggregations", {})
    return {
        "items": [_hit(hit["_source"], hit.get("highlight")) for hit in page_hits],
        "page": {"next_cursor": next_cursor, "has_more": has_more},
        "total": min(int(raw["hits"]["total"]["value"]), MAX_TOTAL),
        "facets": {
            "access_level": _buckets(aggregations, "access_level"),
            "owner_organization_id": _named_buckets(aggregations, "owner_organization_id"),
            "purpose": _buckets(aggregations, "purpose"),
            "keyword": _buckets(aggregations, "keyword"),
            "readiness_status": _buckets(aggregations, "readiness_status"),
            **{name: _buckets(aggregations, name) for name in VOCABULARY_FACETS},
            "collecting_organization_id": _named_buckets(aggregations, "collecting_organization_id"),
        },
    }
