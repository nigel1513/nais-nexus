"""Wave 1.5 Stage 1: openapi 1.3.0 research-metadata additions (spec 2026-10-01-research-data-portal-design)."""

import json
from typing import Any

import yaml

from api.platform.settings import Settings
from api.platform.testing.contracts import assert_matches_response, assert_valid_event

NEW_OPS = {
    "updateMe": ("patch", "/me"),
    "transferUserOrganization": ("post", "/users/{user_id}/transfer"),
    "listVocabulary": ("get", "/vocabulary/{scheme}"),
    "createVocabularyTerm": ("post", "/vocabulary/{scheme}"),
    "listDatasetContributors": ("get", "/datasets/{dataset_id}/contributors"),
    "putDatasetContributors": ("put", "/datasets/{dataset_id}/contributors"),
    "getDatasetJsonLd": ("get", "/datasets/{dataset_id}/metadata.jsonld"),
    "getFileProfile": ("get", "/dataset-files/{file_id}/profile"),
    "getFilePreview": ("get", "/dataset-files/{file_id}/preview"),
}
PERSON = {
    "user_id": "00000000-0000-7000-8000-000000000b02",
    "display_name": "B Researcher",
    "national_researcher_number": "10000002",
    "status": "ACTIVE",
    "affiliation": {"organization_id": "00000000-0000-7000-8000-00000000000b", "name": "Institute B"},
    "current_organization": {
        "organization_id": "00000000-0000-7000-8000-00000000000b",
        "name": "Institute B",
    },
}


def _spec() -> dict[str, Any]:
    spec: dict[str, Any] = yaml.safe_load((Settings().contracts_dir / "openapi.yaml").read_text("utf-8"))
    return spec


def test_version_and_new_operations() -> None:
    spec = _spec()
    assert tuple(int(p) for p in spec["info"]["version"].split(".")[:2]) >= (1, 4)
    for op_id, (method, path) in NEW_OPS.items():
        op = spec["paths"][path][method]
        assert op["operationId"] == op_id
        assert op["responses"]["401"] == {"$ref": "#/components/responses/Error"}, op_id


def test_dataset_create_requires_people_and_dataset_fields_are_optional() -> None:
    schemas = _spec()["components"]["schemas"]
    create = schemas["DatasetCreate"]
    assert {"principal_investigator_id", "data_steward_contact_id"} <= set(create["required"])
    dataset = schemas["Dataset"]
    for field in (
        "people",
        "subject_codes",
        "temporal_start",
        "collecting_organization",
        "contact_email_public",
    ):
        assert field in dataset["properties"] and field not in dataset["required"], field


def test_dataset_with_people_block_matches() -> None:
    body = {
        "dataset_id": "00000000-0000-7000-8000-000000002001",
        "owner_organization_id": "00000000-0000-7000-8000-00000000000b",
        "title": "Battery Cycling Measurements",
        "description": "d",
        "access_level": "CONTROLLED",
        "license": "CC-BY-4.0",
        "policy": {
            "dataset_id": "00000000-0000-7000-8000-000000002001",
            "owner_organization_id": "00000000-0000-7000-8000-00000000000b",
            "access_level": "CONTROLLED",
            "allowed_purposes": ["ACADEMIC_RESEARCH"],
            "approval_required": True,
            "max_grant_days": 180,
        },
        "status": "ACTIVE",
        "created_at": "2026-10-01T00:00:00Z",
        "updated_at": "2026-10-01T00:00:00Z",
        "people": {
            "principal_investigator": PERSON,
            "steward_contact": {**PERSON, "email": "b.steward@inst-b.local"},
            "contributors": [{**PERSON, "role": "CO_INVESTIGATOR"}],
            "steward_contact_absent": False,
        },
        "subject_codes": ["MATERIALS"],
        "material_codes": [],
        "method_codes": ["SENSOR_LOGGING"],
        "temporal_start": "2026-01-01",
        "temporal_end": None,
        "collecting_organization": {"organization_id": None, "name": "K-Lab"},
        "update_frequency": "ONCE",
        "related_publications": [{"title": "Paper", "doi": "10.1234/abc"}],
        "contact_email_public": True,
    }
    assert_matches_response("getDataset", 200, body)


def test_new_events_validate() -> None:
    for event_type, producer, payload in (
        (
            "identity.user.updated.v1",
            "identity",
            {
                "user_id": PERSON["user_id"],
                "organization_id": PERSON["affiliation"]["organization_id"],
                "changed_fields": ["national_researcher_number"],
            },
        ),
        (
            "catalog.dataset.metadata_changed.v1",
            "catalog",
            {
                "dataset_id": "00000000-0000-7000-8000-000000002001",
                "owner_organization_id": "00000000-0000-7000-8000-00000000000b",
                "changed_fields": ["subject_codes", "temporal_start"],
            },
        ),
    ):
        assert_valid_event(
            {
                "event_id": "00000000-0000-7000-8000-00000000f001",
                "event_type": event_type,
                "occurred_at": "2026-10-01T00:00:00Z",
                "producer": producer,
                "correlation_id": "00000000-0000-7000-8000-00000000f002",
                "actor": {"type": "SYSTEM", "user_id": None, "organization_id": None},
                "payload": payload,
            }
        )
    index = json.loads((Settings().contracts_dir / "events" / "index.json").read_text("utf-8"))
    assert {"identity.user.updated.v1", "catalog.dataset.metadata_changed.v1"} <= {
        e["event_type"] for e in index["events"]
    }


def test_file_profile_and_preview_shapes() -> None:
    file_id = "00000000-0000-7000-8000-00000000f010"
    assert_matches_response(
        "getFileProfile",
        200,
        {
            "file_id": file_id,
            "path": "data/measurements.csv",
            "status": "READY",
            "generated_at": "2026-10-01T00:00:00Z",
            "format": "csv",
            "rows_sampled": 1000,
            "truncated": False,
            "columns_truncated": False,
            "columns": [
                {
                    "name": "temperature_c",
                    "type": "number",
                    "unit": "Cel",
                    "description": "시편 온도",
                    "concept_iri": "http://qudt.org/vocab/quantitykind/Temperature",
                    "missing_ratio": 0.0,
                    "distinct_count": 812,
                    "distinct_capped": False,
                }
            ],
        },
    )
    assert_matches_response(
        "getFileProfile", 200, {"file_id": file_id, "path": "a.bin", "status": "UNSUPPORTED", "columns": []}
    )
    assert_matches_response(
        "getFilePreview",
        200,
        {
            "file_id": file_id,
            "status": "READY",
            "header": ["temperature_c", "material"],
            "rows": [["21.5", "AL"], [None, "CU"]],
            "rows_truncated": False,
            "columns": [
                {
                    "name": "temperature_c",
                    "kind": "numeric",
                    "min": 20.1,
                    "max": 80.0,
                    "mean": 45.2,
                    "histogram": [{"lower": 20.1, "upper": 26.09, "count": 98}],
                },
                {"name": "material", "kind": "categorical", "top_values": [{"value": "AL", "count": 400}]},
            ],
        },
    )
    assert "403" in _spec()["paths"]["/dataset-files/{file_id}/preview"]["get"]["responses"]


def test_subtitle_field() -> None:
    schemas = _spec()["components"]["schemas"]
    for name in ("DatasetCreate", "DatasetUpdate", "Dataset", "DatasetSearchHit"):
        assert "subtitle" in schemas[name]["properties"], name
    assert schemas["DatasetCreate"]["properties"]["subtitle"]["maxLength"] == 160


def test_jsonld_declares_both_media_types() -> None:
    content = _spec()["paths"]["/datasets/{dataset_id}/metadata.jsonld"]["get"]["responses"]["200"]["content"]
    assert set(content) == {"application/ld+json", "application/json"}


def test_search_filters_and_facets_p13() -> None:
    spec = _spec()
    params = spec["paths"]["/datasets"]["get"]["parameters"]
    names = {p["name"] for p in params if "name" in p}
    assert {
        "subject",
        "material",
        "method",
        "collecting_organization_id",
        "principal_investigator_id",
        "temporal_from",
        "temporal_to",
    } <= names
    facets = spec["components"]["schemas"]["DatasetSearchResult"]["allOf"][1]["properties"]["facets"][
        "properties"
    ]
    assert {"subject", "material", "method", "collecting_organization_id"} <= set(facets)
