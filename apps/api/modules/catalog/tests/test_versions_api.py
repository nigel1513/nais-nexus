from uuid import UUID, uuid4

import pytest

from api.modules.catalog.tests.support import SHA_A, execute, insert_file, insert_version
from api.modules.catalog.tests.support_api import CatalogApi, assert_error, create_dataset, new_draft
from api.platform.testing.contracts import assert_matches_response
from api.platform.testing.fixtures import PgUrls


def test_steward_creates_a_draft_version(api: CatalogApi) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    response = api.post(
        "b.steward",
        f"/datasets/{dataset_id}/versions",
        json={"version_label": "2026.09", "change_note": "first"},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert_matches_response("createDatasetVersion", 201, body)
    assert (body["status"], body["files"], body["file_count"], body["manifest_sha256"]) == (
        "DRAFT",
        [],
        0,
        None,
    )
    assert body["dataset_id"] == dataset_id and body["change_note"] == "first"


def test_at13_new_version_after_publish_and_label_reuse(api: CatalogApi, db: PgUrls) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    insert_version(db, UUID(dataset_id), label="v1", published=True, files=[("data/a.csv", 10, SHA_A)])
    response = api.post("b.steward", f"/datasets/{dataset_id}/versions", json={"version_label": "v2"})
    assert response.status_code == 201
    response = api.post("b.steward", f"/datasets/{dataset_id}/versions", json={"version_label": "v1"})
    assert response.status_code == 409
    assert_matches_response("createDatasetVersion", 409, response.json())
    assert response.json()["error"]["code"] == "DATASET_VERSION_LABEL_EXISTS"


def test_several_drafts_may_coexist(api: CatalogApi) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    for label in ("a", "b"):
        assert (
            api.post(
                "b.steward", f"/datasets/{dataset_id}/versions", json={"version_label": label}
            ).status_code
            == 201
        )


def test_withdrawn_dataset_gets_no_new_versions(api: CatalogApi, db: PgUrls) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    execute(db, "UPDATE catalog.datasets SET status = 'WITHDRAWN' WHERE dataset_id = :id", id=dataset_id)
    response = api.post("b.steward", f"/datasets/{dataset_id}/versions", json={"version_label": "v1"})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "CONFLICT"


@pytest.mark.parametrize("label", ["", "has space", "x" * 33, "ü"])
def test_bad_labels_are_rejected(api: CatalogApi, label: str) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    response = api.post("b.steward", f"/datasets/{dataset_id}/versions", json={"version_label": label})
    assert response.status_code == 422


def test_version_creation_permissions(api: CatalogApi) -> None:
    dataset_id = create_dataset(api, access_level="INTERNAL")["dataset_id"]
    response = api.post("b.researcher", f"/datasets/{dataset_id}/versions", json={"version_label": "v1"})
    assert response.status_code == 403
    assert_matches_response("createDatasetVersion", 403, response.json())
    assert_error(
        "createDatasetVersion",
        api.post("a.steward", f"/datasets/{dataset_id}/versions", json={"version_label": "v1"}),
        404,
        "NOT_FOUND",
    )


def test_list_versions_by_role(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, draft_id = new_draft(api)
    published_id = insert_version(
        db, UUID(dataset_id), label="v0", published=True, files=[("data/a.csv", 10, SHA_A)]
    )
    expectations = {
        "b.steward": {draft_id, str(published_id)},
        "b.admin": {draft_id, str(published_id)},
        "platform.admin": {draft_id, str(published_id)},
        "b.researcher": {str(published_id)},
        "a.researcher": {str(published_id)},
    }
    for user, expected in expectations.items():
        response = api.get(user, f"/datasets/{dataset_id}/versions")
        assert response.status_code == 200, user
        assert_matches_response("listDatasetVersions", 200, response.json())
        assert {item["dataset_version_id"] for item in response.json()["items"]} == expected, user


def test_list_versions_of_invisible_dataset_is_404(api: CatalogApi) -> None:
    dataset_id, _ = new_draft(api)
    assert_error(
        "listDatasetVersions", api.get("a.researcher", f"/datasets/{dataset_id}/versions"), 404, "NOT_FOUND"
    )


def test_at17_draft_version_is_404_for_non_stewards(api: CatalogApi) -> None:  # M03-AT-17 (GET v-draft)
    _, version_id = new_draft(api)
    for user in ("a.researcher", "b.researcher"):
        response = api.get(user, f"/dataset-versions/{version_id}")
        assert response.status_code == 404, user
        assert_matches_response("getDatasetVersion", 404, response.json())
    assert api.get("b.steward", f"/dataset-versions/{version_id}").status_code == 200


def test_version_manifest_has_no_storage_details(api: CatalogApi, db: PgUrls) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    version_id = insert_version(
        db, UUID(dataset_id), published=True, files=[("data/b.csv", 20, SHA_A), ("B.csv", 10, SHA_A)]
    )
    response = api.get("a.researcher", f"/dataset-versions/{version_id}")
    assert response.status_code == 200
    body = response.json()
    assert_matches_response("getDatasetVersion", 200, body)
    assert [f["path"] for f in body["files"]] == ["B.csv", "data/b.csv"]
    assert (body["file_count"], body["total_bytes"]) == (2, 30)
    assert (
        "storage" not in response.text
        and "nais-inst-b" not in response.text
        and "datasets/" not in response.text
    )


def test_draft_files_are_listed_with_their_status(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    insert_file(db, UUID(version_id), path="data/a.csv", status="FAILED")
    body = api.get("b.steward", f"/dataset-versions/{version_id}").json()
    assert [(f["path"], f["status"]) for f in body["files"]] == [("data/a.csv", "FAILED")]


def test_unknown_version_is_404(api: CatalogApi) -> None:
    assert api.get("b.steward", f"/dataset-versions/{uuid4()}").status_code == 404
