import pytest

from api.modules.catalog.tests.support import execute, rows
from api.modules.catalog.tests.support_api import CatalogApi, assert_error
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


def test_seeded_subjects_are_listed(api: CatalogApi) -> None:
    response = api.get("a.researcher", "/vocabulary/SUBJECT")
    assert response.status_code == 200, response.text
    body = response.json()
    assert_matches_response("listVocabulary", 200, body)
    codes = [t["code"] for t in body["items"]]
    assert {"MATERIALS", "ENERGY", "CHEMISTRY"} <= set(codes)
    assert all(t["scheme"] == "SUBJECT" and t["iri"] is None for t in body["items"])


def test_unknown_scheme_is_422(api: CatalogApi) -> None:
    assert_error("listVocabulary", api.get("a.researcher", "/vocabulary/COLOR"), 422, "VALIDATION_FAILED")


def test_platform_admin_adds_a_term(api: CatalogApi, db: PgUrls) -> None:
    response = api.post(
        "platform.admin",
        "/vocabulary/MATERIAL",
        json={
            "code": "PEROVSKITE",
            "label_ko": "페로브스카이트",
            "label_en": "Perovskite",
            "iri": "https://example.org/perovskite",
            "parent_code": "SEMICONDUCTOR",
        },
    )
    assert response.status_code == 201, response.text
    assert_matches_response("createVocabularyTerm", 201, response.json())
    assert_error(
        "createVocabularyTerm",
        api.post(
            "platform.admin",
            "/vocabulary/MATERIAL",
            json={"code": "PEROVSKITE", "label_ko": "x", "label_en": "x"},
        ),
        409,
        "CONFLICT",
    )
    execute(db, "DELETE FROM catalog.vocabulary_terms WHERE code = 'PEROVSKITE'")


@pytest.mark.parametrize("user", ["b.steward", "a.admin"])
def test_only_platform_admin_adds_terms(api: CatalogApi, user: str) -> None:
    assert_error(
        "createVocabularyTerm",
        api.post(user, "/vocabulary/SUBJECT", json={"code": "XX", "label_ko": "x", "label_en": "x"}),
        403,
        "FORBIDDEN",
    )


def test_unknown_parent_is_422(api: CatalogApi) -> None:
    error = assert_error(
        "createVocabularyTerm",
        api.post(
            "platform.admin",
            "/vocabulary/SUBJECT",
            json={"code": "YY", "label_ko": "y", "label_en": "y", "parent_code": "NOPE"},
        ),
        422,
        "VALIDATION_FAILED",
    )
    assert error["details"]["fields"] == [{"field": "parent_code", "reason": "VOCABULARY_TERM_UNKNOWN"}]


def test_dataset_columns_exist(db: PgUrls) -> None:
    cols = {
        r["column_name"]
        for r in rows(
            db,
            "SELECT column_name FROM information_schema.columns"
            " WHERE table_schema='catalog' AND table_name='datasets'",
        )
    }
    assert {
        "subtitle",
        "principal_investigator_id",
        "principal_investigator_org_id",
        "data_steward_contact_id",
        "data_steward_contact_org_id",
        "contact_email_public",
        "project_title",
        "project_code",
        "funding_agency",
        "subject_codes",
        "method_codes",
        "material_codes",
        "method_detail",
        "temporal_start",
        "temporal_end",
        "collecting_organization_id",
        "collecting_organization_name",
        "update_frequency",
        "related_publications",
        "doi",
    } <= cols
