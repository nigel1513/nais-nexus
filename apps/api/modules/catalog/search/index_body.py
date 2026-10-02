"""nais-datasets-v2 definition (M03 §10). infra/opensearch/*.json are generated from this module."""

import copy
from typing import Any

INDEX_VERSION = 2


def _text() -> dict[str, Any]:
    return {"type": "text", "analyzer": "ko_en"}


MAPPINGS: dict[str, Any] = {
    "dynamic": "strict",
    "properties": {
        "dataset_id": {"type": "keyword"},
        "title": {**_text(), "fields": {"raw": {"type": "keyword", "normalizer": "lc"}}},
        "description": _text(),
        "snippet": {"type": "keyword", "index": False},
        "keywords": {"type": "keyword", "normalizer": "lc", "fields": {"text": _text()}},
        "domain": {"type": "keyword"},
        "access_level": {"type": "keyword"},
        "owner_organization_id": {"type": "keyword"},
        "owner_organization_name": {"type": "keyword", "fields": {"text": _text()}},
        "allowed_purposes": {"type": "keyword"},
        "license": {"type": "keyword"},
        "status": {"type": "keyword"},
        "has_published_version": {"type": "boolean"},
        "latest_version_id": {"type": "keyword"},
        "latest_version_label": {"type": "keyword"},
        "readiness_overall": {"type": "keyword"},
        "published_at": {"type": "date"},
        "updated_at": {"type": "date"},
        "subtitle": _text(),
        "subject_codes": {"type": "keyword"},
        "material_codes": {"type": "keyword"},
        "method_codes": {"type": "keyword"},
        "subject_labels": _text(),
        "temporal_start": {"type": "date", "format": "strict_date"},
        "temporal_end": {"type": "date", "format": "strict_date"},
        "collecting_organization_id": {"type": "keyword"},
        "collecting_organization_name": {"type": "keyword", "fields": {"text": _text()}},
        "principal_investigator_id": {"type": "keyword"},
        "principal_investigator_name": {"type": "keyword", "fields": {"text": _text()}},
    },
}


def _analysis(nori: bool) -> dict[str, Any]:
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


def index_body(*, nori: bool) -> dict[str, Any]:
    return {
        "settings": {"number_of_shards": 1, "analysis": _analysis(nori)},
        "mappings": copy.deepcopy(MAPPINGS),
    }
