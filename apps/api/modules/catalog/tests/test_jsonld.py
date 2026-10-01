from api.modules.catalog.tests.support import ORG_B
from api.modules.catalog.tests.support_api import CatalogApi, create_dataset
from api.platform.testing.contracts import assert_matches_response

BASE = "http://localhost:21051"


def test_jsonld_document_shape(api: CatalogApi) -> None:
    ds = create_dataset(
        api,
        subject_codes=["MATERIALS"],
        method_codes=["XRD"],
        temporal_start="2024-01-01",
        temporal_end="2025-12-31",
        project_title="P",
        funding_agency="NST",
        contact_email_public=True,
        related_publications=[{"title": "Paper", "doi": "10.1234/abc"}],
    )
    response = api.get("b.researcher", f"/datasets/{ds['dataset_id']}/metadata.jsonld")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("application/ld+json")
    doc = response.json()
    assert_matches_response("getDatasetJsonLd", 200, doc)
    assert doc["@context"]["@vocab"] == "https://schema.org/"
    assert doc["@type"] == ["Dataset", "dcat:Dataset"]
    assert doc["@id"] == f"{BASE}/id/dataset/{ds['dataset_id']}"
    assert doc["temporalCoverage"] == "2024-01-01/2025-12-31"
    assert doc["publisher"] == {
        "@type": "Organization",
        "@id": f"{BASE}/id/organization/{ORG_B}",
        "name": "Institute B",
    }
    creator = doc["creator"][0]
    assert creator["@type"] == "Person" and creator["name"] == "B Researcher"
    assert creator["identifier"] == {"@type": "PropertyValue", "propertyID": "NTIS", "value": "10000002"}
    assert creator["affiliation"]["name"] == "Institute B"
    assert doc["about"][0] == {
        "@type": "DefinedTerm",
        "@id": f"{BASE}/vocabulary/SUBJECT/MATERIALS",
        "termCode": "MATERIALS",
        "name": "재료",
        "inDefinedTermSet": f"{BASE}/vocabulary/SUBJECT",
    }
    assert doc["measurementTechnique"][0]["termCode"] == "XRD"
    assert doc["citation"] == [
        {"@type": "ScholarlyArticle", "name": "Paper", "sameAs": "https://doi.org/10.1234/abc"}
    ]
    assert doc["maintainer"]["email"] == "b.steward@inst-b.local"


def test_defined_terms_carry_vocabulary_iri_ids(api: CatalogApi) -> None:
    """Ruling P7: every DefinedTerm has @id = NAIS_PUBLIC_BASE_URL + /vocabulary/{scheme}/{code}."""
    ds = create_dataset(
        api, subject_codes=["MATERIALS", "ENERGY"], material_codes=["ELECTROLYTE"], method_codes=["XRD"]
    )
    doc = api.get("b.researcher", f"/datasets/{ds['dataset_id']}/metadata.jsonld").json()
    terms = doc["about"] + doc["measurementTechnique"]
    assert [t["@id"] for t in terms] == [
        f"{BASE}/vocabulary/SUBJECT/MATERIALS",
        f"{BASE}/vocabulary/SUBJECT/ENERGY",
        f"{BASE}/vocabulary/MATERIAL/ELECTROLYTE",
        f"{BASE}/vocabulary/METHOD/XRD",
    ]


def test_jsonld_base_url_comes_from_settings(api: CatalogApi) -> None:
    from dataclasses import replace

    api.use(
        replace(
            api.deps,
            settings=api.deps.settings.model_copy(update={"nais_public_base_url": "https://nais.example/"}),
        )
    )
    ds = create_dataset(api, subject_codes=["MATERIALS"])
    doc = api.get("b.researcher", f"/datasets/{ds['dataset_id']}/metadata.jsonld").json()
    assert doc["@id"] == f"https://nais.example/id/dataset/{ds['dataset_id']}"
    assert doc["about"][0]["@id"] == "https://nais.example/vocabulary/SUBJECT/MATERIALS"


def test_jsonld_never_leaks_private_email(api: CatalogApi) -> None:
    ds = create_dataset(api)
    contributors = [{"user_id": ds["people"]["steward_contact"]["user_id"], "role": "DATA_CURATOR"}]
    response = api.request(
        "PUT", "b.steward", f"/datasets/{ds['dataset_id']}/contributors", json={"contributors": contributors}
    )
    assert response.status_code == 200, response.text
    text = api.get("b.researcher", f"/datasets/{ds['dataset_id']}/metadata.jsonld").text
    assert "@inst-b.local" not in text and '"email"' not in text


def test_open_ended_period_and_visibility(api: CatalogApi) -> None:
    ds = create_dataset(api, temporal_start="2025-07-01")
    doc = api.get("b.researcher", f"/datasets/{ds['dataset_id']}/metadata.jsonld").json()
    assert doc["temporalCoverage"] == "2025-07-01/.."
    assert api.get("a.researcher", f"/datasets/{ds['dataset_id']}/metadata.jsonld").status_code == 404
