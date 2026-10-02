from uuid import UUID

import pytest

from api.modules.catalog.adapters.identity import FakeIdentityPort
from api.modules.catalog.tests.support import ORG_A, ORG_B, outbox_events, rows, seed_user_id
from api.modules.catalog.tests.support_api import CatalogApi, assert_error, create_dataset, dataset_body
from api.platform.testing.contracts import assert_matches_response, assert_valid_event
from api.platform.testing.fixtures import PgUrls

B_RESEARCHER = seed_user_id("0b02")
B_STEWARD = seed_user_id("0b03")
A_RESEARCHER = seed_user_id("0a02")

FULL = {
    "subtitle": "전해질 후보 120종의 충방전 특성",
    "subject_codes": ["MATERIALS", "ENERGY"],
    "material_codes": ["ELECTROLYTE"],
    "method_codes": ["ELECTROCHEM_CYCLING"],
    "method_detail": "Arbin BT-2000, 25 °C",
    "temporal_start": "2024-01-01",
    "temporal_end": "2025-12-31",
    "collecting_organization_id": str(ORG_B),
    "project_title": "전해질 스크리닝",
    "project_code": "NST-2026-0001",
    "funding_agency": "국가과학기술연구회",
    "update_frequency": "YEARLY",
    "related_publications": [{"title": "Paper", "doi": "10.1234/abc"}],
}


def test_create_with_research_metadata_and_people(api: CatalogApi) -> None:
    response = api.post("b.steward", "/datasets", json=dataset_body(**FULL))
    assert response.status_code == 201, response.text
    body = response.json()
    assert_matches_response("createDataset", 201, body)
    assert body["subject_codes"] == ["MATERIALS", "ENERGY"]
    assert body["subtitle"] == "전해질 후보 120종의 충방전 특성"
    assert body["collecting_organization"] == {"organization_id": str(ORG_B), "name": "Institute B"}
    pi = body["people"]["principal_investigator"]
    assert pi["user_id"] == str(B_RESEARCHER) and pi["display_name"] == "B Researcher"
    assert pi["national_researcher_number"] == "10000002"
    assert (
        pi["affiliation"]
        == pi["current_organization"]
        == {"organization_id": str(ORG_B), "name": "Institute B"}
    )
    assert "email" not in body["people"]["steward_contact"]
    assert body["people"]["steward_contact_absent"] is False
    assert body["people"]["contributors"] == []
    assert "stats" not in body  # no published version yet


@pytest.mark.parametrize(
    ("override", "field", "reason"),
    [
        (
            {"principal_investigator_id": str(A_RESEARCHER)},
            "principal_investigator_id",
            "PERSON_NOT_ELIGIBLE",
        ),
        (
            {"data_steward_contact_id": str(seed_user_id("0b04"))},
            "data_steward_contact_id",
            "PERSON_NOT_ELIGIBLE",
        ),
        ({"subject_codes": ["NOPE"]}, "subject_codes", "VOCABULARY_TERM_UNKNOWN"),
        ({"temporal_start": "2025-01-02", "temporal_end": "2025-01-01"}, "temporal_end", "TEMPORAL_RANGE"),
        (
            {"collecting_organization_id": "00000000-0000-7000-8000-00000000ffff"},
            "collecting_organization_id",
            "UNKNOWN_ORGANIZATION",
        ),
        (
            {"collecting_organization_id": str(ORG_B), "collecting_organization_name": "K-Lab"},
            "collecting_organization_name",
            "MUTUALLY_EXCLUSIVE",
        ),
    ],
)
def test_create_rejects_bad_research_fields(
    api: CatalogApi, override: dict[str, object], field: str, reason: str
) -> None:
    error = assert_error(
        "createDataset",
        api.post("b.steward", "/datasets", json=dataset_body(**override)),
        422,
        "VALIDATION_FAILED",
    )
    assert {"field": field, "reason": reason} in error["details"]["fields"]


def test_missing_people_is_422(api: CatalogApi) -> None:
    body = dataset_body()
    del body["principal_investigator_id"]
    assert_error("createDataset", api.post("b.steward", "/datasets", json=body), 422, "VALIDATION_FAILED")


def test_email_only_when_contact_email_public(api: CatalogApi) -> None:
    hidden = create_dataset(api)
    # Unpublished datasets are visible only inside the owner organization (D-012).
    assert (
        "email"
        not in api.get("b.researcher", f"/datasets/{hidden['dataset_id']}").json()["people"][
            "steward_contact"
        ]
    )
    shown = create_dataset(api, contact_email_public=True)
    people = api.get("b.researcher", f"/datasets/{shown['dataset_id']}").json()["people"]
    assert people["steward_contact"]["email"] == "b.steward@inst-b.local"
    assert "email" not in people["principal_investigator"]


def test_absent_steward_hides_public_email(api: CatalogApi) -> None:
    ds = create_dataset(api, contact_email_public=True)
    fake = api.deps.organizations
    assert isinstance(fake, FakeIdentityPort)
    fake.move(B_STEWARD, ORG_A)
    people = api.get("b.researcher", f"/datasets/{ds['dataset_id']}").json()["people"]
    assert people["steward_contact_absent"] is True
    assert "email" not in people["steward_contact"]


def test_update_emits_metadata_changed_with_sorted_fields(api: CatalogApi, db: PgUrls) -> None:
    ds = create_dataset(api)
    response = api.patch(
        "b.steward",
        f"/datasets/{ds['dataset_id']}",
        json={"temporal_start": "2024-01-01", "subject_codes": ["MATERIALS"], "title": "New title"},
    )
    assert response.status_code == 200, response.text
    assert_matches_response("updateDataset", 200, response.json())
    [event] = outbox_events(db, "catalog.dataset.metadata_changed.v1")
    assert_valid_event(event)
    assert event["payload"]["changed_fields"] == ["subject_codes", "temporal_start", "title"]


def test_policy_only_change_emits_no_metadata_event(api: CatalogApi, db: PgUrls) -> None:
    ds = create_dataset(api)
    api.patch("b.steward", f"/datasets/{ds['dataset_id']}", json={"max_grant_days": 90})
    assert outbox_events(db, "catalog.dataset.metadata_changed.v1") == []


def test_unchanged_values_emit_no_metadata_event(api: CatalogApi, db: PgUrls) -> None:
    ds = create_dataset(api)
    response = api.patch("b.steward", f"/datasets/{ds['dataset_id']}", json={"title": ds["title"]})
    assert response.status_code == 200, response.text
    assert outbox_events(db, "catalog.dataset.metadata_changed.v1") == []


def test_nullable_research_fields_clear_and_core_fields_reject_null(api: CatalogApi) -> None:
    ds = create_dataset(api, temporal_start="2024-01-01", temporal_end="2024-12-31")
    cleared = api.patch("b.steward", f"/datasets/{ds['dataset_id']}", json={"temporal_end": None})
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["temporal_end"] is None
    assert_error(
        "updateDataset",
        api.patch("b.steward", f"/datasets/{ds['dataset_id']}", json={"title": None}),
        422,
        "VALIDATION_FAILED",
    )
    assert_error(
        "updateDataset",
        api.patch("b.steward", f"/datasets/{ds['dataset_id']}", json={"principal_investigator_id": None}),
        422,
        "VALIDATION_FAILED",
    )


def test_update_temporal_range_uses_stored_start(api: CatalogApi) -> None:
    ds = create_dataset(api, temporal_start="2024-06-01")
    error = assert_error(
        "updateDataset",
        api.patch("b.steward", f"/datasets/{ds['dataset_id']}", json={"temporal_end": "2024-01-01"}),
        422,
        "VALIDATION_FAILED",
    )
    assert {"field": "temporal_end", "reason": "TEMPORAL_RANGE"} in error["details"]["fields"]


def test_update_collecting_organization_exclusive_on_merged_result(api: CatalogApi) -> None:
    ds = create_dataset(api, collecting_organization_id=str(ORG_B))
    url = f"/datasets/{ds['dataset_id']}"
    error = assert_error(
        "updateDataset",
        api.patch("b.steward", url, json={"collecting_organization_name": "K-Lab"}),
        422,
        "VALIDATION_FAILED",
    )
    assert {"field": "collecting_organization_name", "reason": "MUTUALLY_EXCLUSIVE"} in error["details"][
        "fields"
    ]
    switched = api.patch(
        "b.steward", url, json={"collecting_organization_id": None, "collecting_organization_name": "K-Lab"}
    )
    assert switched.status_code == 200, switched.text
    assert switched.json()["collecting_organization"] == {"organization_id": None, "name": "K-Lab"}


def test_update_rejects_different_ineligible_person(api: CatalogApi) -> None:
    ds = create_dataset(api)
    error = assert_error(
        "updateDataset",
        api.patch(
            "b.steward",
            f"/datasets/{ds['dataset_id']}",
            json={"principal_investigator_id": str(A_RESEARCHER)},
        ),
        422,
        "VALIDATION_FAILED",
    )
    assert {"field": "principal_investigator_id", "reason": "PERSON_NOT_ELIGIBLE"} in error["details"][
        "fields"
    ]


def test_update_keeps_historic_pi_affiliation_after_transfer(api: CatalogApi, db: PgUrls) -> None:
    ds = create_dataset(api)
    fake = api.deps.organizations
    assert isinstance(fake, FakeIdentityPort)
    fake.move(B_RESEARCHER, ORG_A)
    url = f"/datasets/{ds['dataset_id']}"
    response = api.patch("b.steward", url, json={"title": "Renamed dataset"})
    assert response.status_code == 200, response.text
    pi = response.json()["people"]["principal_investigator"]
    assert pi["affiliation"]["organization_id"] == str(ORG_B)
    assert pi["current_organization"]["organization_id"] == str(ORG_A)
    # Re-saving the unchanged historic PI is accepted and never rewrites the at-the-time affiliation.
    resaved = api.patch("b.steward", url, json={"principal_investigator_id": str(B_RESEARCHER)})
    assert resaved.status_code == 200, resaved.text
    [row] = rows(
        db,
        "SELECT principal_investigator_org_id FROM catalog.datasets WHERE dataset_id = :d",
        d=UUID(ds["dataset_id"]),
    )
    assert row["principal_investigator_org_id"] == ORG_B
    # Assigning a DIFFERENT ineligible person (the moved steward) is rejected.
    fake.move(B_STEWARD, ORG_A)
    error = assert_error(
        "updateDataset",
        api.patch("b.steward", url, json={"data_steward_contact_id": str(A_RESEARCHER)}),
        422,
        "VALIDATION_FAILED",
    )
    assert {"field": "data_steward_contact_id", "reason": "PERSON_NOT_ELIGIBLE"} in error["details"]["fields"]


def test_steward_absent_after_transfer(api: CatalogApi) -> None:
    ds = create_dataset(api)
    fake = api.deps.organizations
    assert isinstance(fake, FakeIdentityPort)
    fake.move(B_STEWARD, ORG_A)
    people = api.get("b.researcher", f"/datasets/{ds['dataset_id']}").json()["people"]
    assert people["steward_contact_absent"] is True


def test_reassigning_steward_records_new_affiliation(api: CatalogApi, db: PgUrls) -> None:
    ds = create_dataset(api)
    response = api.patch(
        "b.steward", f"/datasets/{ds['dataset_id']}", json={"data_steward_contact_id": str(B_RESEARCHER)}
    )
    assert response.status_code == 200, response.text
    assert response.json()["people"]["steward_contact"]["user_id"] == str(B_RESEARCHER)
    [row] = rows(
        db,
        "SELECT data_steward_contact_id, data_steward_contact_org_id FROM catalog.datasets WHERE dataset_id = :d",
        d=UUID(ds["dataset_id"]),
    )
    assert row == {"data_steward_contact_id": B_RESEARCHER, "data_steward_contact_org_id": ORG_B}
