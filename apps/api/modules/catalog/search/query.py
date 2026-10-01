"""searchDatasets query DSL (M03 §6.2). Visibility is a query filter, never a post-filter (D-012)."""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.pagination import decode_cursor, encode_cursor

MAX_TOTAL = 10_000
DISCOVERABLE_LEVELS = ["PUBLIC", "CONTROLLED", "SENSITIVE"]
SORTS: dict[str, list[dict[str, str]]] = {
    "relevance": [{"_score": "desc"}, {"dataset_id": "asc"}],
    "updated_desc": [{"updated_at": "desc"}, {"dataset_id": "asc"}],
    "title_asc": [{"title.raw": "asc"}, {"dataset_id": "asc"}],
}
SEARCH_FIELDS = ["title^3", "keywords.text^2", "description", "owner_organization_name.text"]
AGGREGATIONS: dict[str, Any] = {
    "access_level": {"terms": {"field": "access_level", "size": 4}},
    "owner_organization_id": {
        "terms": {"field": "owner_organization_id", "size": 50},
        "aggs": {"name": {"terms": {"field": "owner_organization_name", "size": 1}}},
    },
    "purpose": {"terms": {"field": "allowed_purposes", "size": 5}},
    "keyword": {"terms": {"field": "keywords", "size": 20}},
    "readiness_status": {"terms": {"field": "readiness_overall", "size": 3}},
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
)


@dataclass(frozen=True)
class SearchParams:
    q: str | None = None
    access_level: tuple[str, ...] = ()
    owner_organization_id: tuple[UUID, ...] = ()
    purpose: tuple[str, ...] = ()
    keyword: tuple[str, ...] = ()
    readiness_status: tuple[str, ...] = ()
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


def visibility_filter(user: CurrentUser) -> dict[str, Any]:
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


def build_search_body(
    user: CurrentUser, params: SearchParams, sort_name: str, search_after: list[Any] | None
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
    query: dict[str, Any] = {"bool": {"filter": filters}}
    if params.q and params.q.strip():
        query["bool"]["must"] = [{"multi_match": {"query": params.q.strip(), "fields": SEARCH_FIELDS}}]
    body: dict[str, Any] = {
        "query": query,
        "size": params.limit + 1,
        "sort": SORTS[sort_name],
        "track_total_hits": MAX_TOTAL,
        "aggs": AGGREGATIONS,
        "_source": list(HIT_FIELDS),
    }
    if search_after is not None:
        body["search_after"] = search_after
    return body


def _buckets(aggregations: Mapping[Any, Any], name: str) -> list[dict[str, Any]]:
    return [
        {"value": str(bucket["key"]), "count": int(bucket["doc_count"])}
        for bucket in aggregations.get(name, {}).get("buckets", [])
    ]


def _owner_buckets(aggregations: Mapping[Any, Any]) -> list[dict[str, Any]]:
    buckets = []
    for bucket in aggregations.get("owner_organization_id", {}).get("buckets", []):
        item: dict[str, Any] = {"value": str(bucket["key"]), "count": int(bucket["doc_count"])}
        names = bucket.get("name", {}).get("buckets", [])
        if names and names[0]["key"]:
            item["label"] = str(names[0]["key"])
        buckets.append(item)
    return buckets


def _hit(source: Mapping[Any, Any]) -> dict[str, Any]:
    hit = {field: source.get(field) for field in HIT_FIELDS}
    if not hit["owner_organization_name"]:
        hit.pop("owner_organization_name")
    if hit["snippet"] is None:
        hit.pop("snippet")
    hit["keywords"] = list(hit["keywords"] or [])
    hit["allowed_purposes"] = list(hit["allowed_purposes"] or [])
    return hit


def map_search_response(raw: Mapping[Any, Any], *, limit: int, sort_name: str) -> dict[str, Any]:
    hits = raw["hits"]["hits"]
    page_hits = hits[:limit]
    has_more = len(hits) > limit
    next_cursor = encode_cursor([sort_name, *page_hits[-1]["sort"]]) if has_more and page_hits else None
    aggregations = raw.get("aggregations", {})
    return {
        "items": [_hit(hit["_source"]) for hit in page_hits],
        "page": {"next_cursor": next_cursor, "has_more": has_more},
        "total": min(int(raw["hits"]["total"]["value"]), MAX_TOTAL),
        "facets": {
            "access_level": _buckets(aggregations, "access_level"),
            "owner_organization_id": _owner_buckets(aggregations),
            "purpose": _buckets(aggregations, "purpose"),
            "keyword": _buckets(aggregations, "keyword"),
            "readiness_status": _buckets(aggregations, "readiness_status"),
        },
    }
