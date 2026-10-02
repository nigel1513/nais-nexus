import json
from uuid import UUID

from api.modules.catalog.tests.support import rows, seed_user_id
from api.modules.catalog.tests.support_api import CatalogApi, dataset_body
from api.modules.catalog.tests.support_upload import upload_files
from api.platform.testing.fixtures import PgUrls


def publish_with_file(api: CatalogApi, db: PgUrls, dataset_id: str) -> str:
    version_id: str = api.post(
        "b.steward", f"/datasets/{dataset_id}/versions", json={"version_label": "v1"}
    ).json()["dataset_version_id"]
    upload_files(api, db, version_id, {"data/a.csv": b"x,y\n1,2\n"})
    assert api.post("b.steward", f"/dataset-versions/{version_id}/publish").status_code == 200
    return version_id


def snapshot(db: PgUrls, version_id: str) -> dict:  # type: ignore[type-arg]
    [row] = rows(
        db,
        "SELECT metadata_snapshot FROM catalog.dataset_versions WHERE dataset_version_id = :v",
        v=UUID(version_id),
    )
    snap: dict = row["metadata_snapshot"]  # type: ignore[type-arg]
    return snap


def test_snapshot_freezes_research_and_people_with_fallbacks(api: CatalogApi, db: PgUrls) -> None:
    body = {
        k: v
        for k, v in dataset_body(subject_codes=["MATERIALS"], temporal_start="2024-01-01").items()
        if k != "domain"
    }
    ds = api.post("b.steward", "/datasets", json=body).json()
    version_id = publish_with_file(api, db, ds["dataset_id"])
    snap = snapshot(db, version_id)
    assert snap["subject_codes"] == ["MATERIALS"] and snap["temporal_start"] == "2024-01-01"
    # Ruling P23: the steward's private account email never enters the snapshot; the steward contact itself is
    # frozen so readiness can treat the contact requirement as satisfied.
    assert snap["contact_email"] is None
    assert snap["data_steward_contact_id"] == str(seed_user_id("0b03"))
    assert snap["domain"] == "MATERIALS"  # fallback: first subject code
    pi = snap["people"]["principal_investigator"]
    assert pi["display_name"] == "B Researcher" and pi["national_researcher_number"] == "10000002"
    assert pi["affiliation"]["name"] == "Institute B"
    assert "email" not in pi
    assert "email" not in snap["people"]["steward_contact"]
    assert "@inst-b.local" not in json.dumps(snap)


def test_snapshot_uses_public_steward_email(api: CatalogApi, db: PgUrls) -> None:
    ds = api.post("b.steward", "/datasets", json=dataset_body(contact_email_public=True)).json()
    snap = snapshot(db, publish_with_file(api, db, ds["dataset_id"]))
    assert snap["contact_email"] == "b.steward@inst-b.local"
    assert "email" not in snap["people"]["steward_contact"]  # people block never carries emails


def test_snapshot_keeps_explicit_contact_email(api: CatalogApi, db: PgUrls) -> None:
    ds = api.post("b.steward", "/datasets", json=dataset_body(contact_email="team@example.org")).json()
    snap = snapshot(db, publish_with_file(api, db, ds["dataset_id"]))
    assert snap["contact_email"] == "team@example.org" and snap["domain"] == "materials"


def test_published_snapshot_research_fields_are_immutable(api: CatalogApi, db: PgUrls) -> None:
    ds = api.post(
        "b.steward", "/datasets", json=dataset_body(subject_codes=["MATERIALS"], project_title="P1")
    ).json()
    version_id = publish_with_file(api, db, ds["dataset_id"])
    patch = {"subject_codes": ["ENERGY"], "project_title": "P2", "temporal_start": "2020-01-01"}
    assert api.patch("b.steward", f"/datasets/{ds['dataset_id']}", json=patch).status_code == 200
    snap = snapshot(db, version_id)
    assert snap["subject_codes"] == ["MATERIALS"] and snap["project_title"] == "P1"
    assert snap["temporal_start"] is None
