from typing import Any
from uuid import UUID

from api.modules.catalog.adapters.identity import FakeIdentityPort
from api.modules.catalog.tests.support import ORG_A, ORG_B, execute, outbox_events, rows, seed_user_id
from api.modules.catalog.tests.support_api import CatalogApi, assert_error, create_dataset
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls

A_RESEARCHER = seed_user_id("0a02")
B_RESEARCHER = seed_user_id("0b02")


def put(api: CatalogApi, dataset_id: str, contributors: list[dict[str, Any]], user: str = "b.steward"):  # type: ignore[no-untyped-def]
    return api.request(
        "PUT", user, f"/datasets/{dataset_id}/contributors", json={"contributors": contributors}
    )


def test_cross_org_contributor_with_affiliation(api: CatalogApi, db: PgUrls) -> None:
    ds = create_dataset(api)
    response = put(api, ds["dataset_id"], [{"user_id": str(A_RESEARCHER), "role": "CO_INVESTIGATOR"}])
    assert response.status_code == 200, response.text
    assert_matches_response("putDatasetContributors", 200, response.json())
    [item] = response.json()["items"]
    assert item["affiliation"]["organization_id"] == str(ORG_A) and item["role"] == "CO_INVESTIGATOR"
    assert "email" not in item
    assert [
        e["payload"]["changed_fields"] for e in outbox_events(db, "catalog.dataset.metadata_changed.v1")
    ] == [["contributors"]]
    listed = api.get("a.researcher", f"/datasets/{ds['dataset_id']}/contributors")
    assert listed.status_code == 404  # draft-only CONTROLLED dataset is invisible to other orgs (D-012)
    own = api.get("b.researcher", f"/datasets/{ds['dataset_id']}/contributors")
    assert own.status_code == 200
    assert_matches_response("listDatasetContributors", 200, own.json())


def test_reput_keeps_affiliation_and_same_list_is_noop(api: CatalogApi, db: PgUrls) -> None:
    ds = create_dataset(api)
    put(api, ds["dataset_id"], [{"user_id": str(A_RESEARCHER), "role": "CO_INVESTIGATOR"}])
    fake = api.deps.organizations
    assert isinstance(fake, FakeIdentityPort)
    fake.move(A_RESEARCHER, ORG_B)
    again = put(api, ds["dataset_id"], [{"user_id": str(A_RESEARCHER), "role": "CO_INVESTIGATOR"}])
    assert again.json()["items"][0]["affiliation"]["organization_id"] == str(ORG_A)
    assert again.json()["items"][0]["current_organization"]["organization_id"] == str(ORG_B)
    assert len(outbox_events(db, "catalog.dataset.metadata_changed.v1")) == 1


def test_validation(api: CatalogApi) -> None:
    ds = create_dataset(api)
    dup = put(api, ds["dataset_id"], [{"user_id": str(B_RESEARCHER), "role": "DATA_CURATOR"}] * 2)
    assert {"field": "contributors", "reason": "DUPLICATE"} in assert_error(
        "putDatasetContributors", dup, 422, "VALIDATION_FAILED"
    )["details"]["fields"]
    disabled = put(api, ds["dataset_id"], [{"user_id": str(seed_user_id("0b04")), "role": "DATA_CURATOR"}])
    assert {"field": "contributors[0].user_id", "reason": "PERSON_NOT_ELIGIBLE"} in assert_error(
        "putDatasetContributors", disabled, 422, "VALIDATION_FAILED"
    )["details"]["fields"]
    assert_error(
        "putDatasetContributors", put(api, ds["dataset_id"], [], user="b.researcher"), 403, "FORBIDDEN"
    )


def test_clearing_removes_rows(api: CatalogApi, db: PgUrls) -> None:
    ds = create_dataset(api)
    put(api, ds["dataset_id"], [{"user_id": str(B_RESEARCHER), "role": "DATA_COLLECTOR"}])
    assert put(api, ds["dataset_id"], []).json() == {"items": []}
    assert (
        rows(db, "SELECT * FROM catalog.dataset_contributors WHERE dataset_id = :d", d=UUID(ds["dataset_id"]))
        == []
    )


def test_more_than_fifty_is_rejected(api: CatalogApi) -> None:
    ds = create_dataset(api)
    many = [{"user_id": str(B_RESEARCHER), "role": "DATA_CURATOR"}] * 51
    assert put(api, ds["dataset_id"], many).status_code == 422


def test_stored_vocabulary_term_deactivated_does_not_block_unrelated_patch(
    api: CatalogApi, db: PgUrls
) -> None:
    ds = create_dataset(api, subject_codes=["MATERIALS"])
    execute(
        db,
        "UPDATE catalog.vocabulary_terms SET active = false WHERE scheme = 'SUBJECT' AND code = 'MATERIALS'",
    )
    ok = api.patch(
        "b.steward",
        f"/datasets/{ds['dataset_id']}",
        json={"title": "Renamed", "subject_codes": ["MATERIALS"]},
    )
    assert ok.status_code == 200, ok.text
    execute(
        db, "UPDATE catalog.vocabulary_terms SET active = false WHERE scheme = 'SUBJECT' AND code = 'ENERGY'"
    )
    added = api.patch(
        "b.steward", f"/datasets/{ds['dataset_id']}", json={"subject_codes": ["MATERIALS", "ENERGY"]}
    )
    assert {"field": "subject_codes", "reason": "VOCABULARY_TERM_UNKNOWN"} in assert_error(
        "updateDataset", added, 422, "VALIDATION_FAILED"
    )["details"]["fields"]
