import hashlib
from uuid import UUID

import pytest
from sqlalchemy.exc import DBAPIError

from api.modules.catalog.domain import manifest_sha256
from api.modules.catalog.tests.support import execute, outbox_events, rows
from api.modules.catalog.tests.support_api import USERS, CatalogApi, new_draft
from api.modules.catalog.tests.support_upload import (
    complete,
    file_spec,
    put_uploaded,
    start_upload,
    upload_files,
)
from api.platform.testing.contracts import assert_matches_response, assert_valid_event
from api.platform.testing.fixtures import PgUrls

FILES = {"data/b.csv": b"x,y\n3,4\n", "README.md": b"# Battery\n", "data/a.csv": b"x,y\n1,2\n"}


def publish(api: CatalogApi, version_id: str, user: str = "b.steward"):  # type: ignore[no-untyped-def]
    return api.post(user, f"/dataset-versions/{version_id}/publish")


def test_publish_freezes_manifest_and_metadata(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, version_id = new_draft(api)
    upload_files(api, db, version_id, FILES)
    response = publish(api, version_id)
    assert response.status_code == 200, response.text
    body = response.json()
    assert_matches_response("publishDatasetVersion", 200, body)
    expected_manifest = manifest_sha256((p, len(d), hashlib.sha256(d).hexdigest()) for p, d in FILES.items())
    assert body["status"] == "PUBLISHED" and body["manifest_sha256"] == expected_manifest
    assert (body["file_count"], body["total_bytes"]) == (3, sum(len(d) for d in FILES.values()))
    [event] = outbox_events(db, "catalog.dataset.version_published.v1")
    assert_valid_event(event)
    assert event["payload"] == {
        "dataset_id": dataset_id,
        "dataset_version_id": version_id,
        "version_label": "v1",
        "owner_organization_id": body_owner(api, dataset_id),
        "file_count": 3,
        "total_bytes": body["total_bytes"],
        "manifest_sha256": expected_manifest,
    }
    assert event["actor"]["user_id"] == str(USERS["b.steward"].user_id)
    [row] = rows(
        db,
        "SELECT metadata_snapshot, published_by FROM catalog.dataset_versions WHERE dataset_version_id = :v",
        v=version_id,
    )
    snapshot = row["metadata_snapshot"]
    assert sorted(snapshot) == [
        "access_level",
        "allowed_purposes",
        "contact_email",
        "description",
        "domain",
        "keywords",
        "license",
        "max_grant_days",
        "provenance",
        "title",
        "usage_policy",
    ]
    assert snapshot["title"] == "Battery Cycling Measurements" and snapshot["allowed_purposes"] == [
        "ACADEMIC_RESEARCH",
        "AI_TRAINING",
    ]
    assert row["published_by"] == USERS["b.steward"].user_id
    assert UUID(dataset_id) in [
        r["dataset_id"] for r in rows(db, "SELECT dataset_id FROM catalog.index_queue")
    ]

    assert (
        api.patch("b.steward", f"/datasets/{dataset_id}", json={"title": "Renamed after publish"}).status_code
        == 200
    )
    again = rows(
        db,
        "SELECT metadata_snapshot FROM catalog.dataset_versions WHERE dataset_version_id = :v",
        v=version_id,
    )
    assert again[0]["metadata_snapshot"]["title"] == "Battery Cycling Measurements"


def body_owner(api: CatalogApi, dataset_id: str) -> str:
    owner: str = api.get("b.steward", f"/datasets/{dataset_id}").json()["owner_organization_id"]
    return owner


def test_at11_version_without_files_is_incomplete(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    response = publish(api, version_id)
    assert response.status_code == 409
    assert_matches_response("publishDatasetVersion", 409, response.json())
    assert response.json()["error"]["code"] == "DATASET_VERSION_INCOMPLETE"
    assert outbox_events(db, "catalog.dataset.version_published.v1") == []


def test_failed_or_pending_files_block_publish(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    upload_files(api, db, version_id, {"data/a.csv": b"x,y\n1,2\n"})
    session_body = start_upload(api, version_id, {"data/b.csv": b"x,y\n3,4\n"})
    put_uploaded(api, db, session_body, {"data/b.csv": b"x,y\n9,9\n"})
    complete(api, session_body["upload_session_id"])
    response = publish(api, version_id)
    assert response.status_code == 409
    error = response.json()["error"]
    assert error["code"] == "DATASET_VERSION_INCOMPLETE"
    assert error["details"]["files"] == [
        {"file_id": session_body["files"][0]["file_id"], "path": "data/b.csv", "status": "FAILED"}
    ]


def test_at12_published_version_is_immutable_via_api_and_db(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    upload_files(api, db, version_id, FILES)
    assert publish(api, version_id).status_code == 200
    response = api.post(
        "b.steward",
        f"/dataset-versions/{version_id}/upload-session",
        json={"files": [file_spec("c.csv", b"1")]},
    )
    assert response.status_code == 409 and response.json()["error"]["code"] == "DATASET_VERSION_IMMUTABLE"
    second = publish(api, version_id)
    assert second.status_code == 409
    assert_matches_response("publishDatasetVersion", 409, second.json())
    assert second.json()["error"]["code"] == "DATASET_VERSION_IMMUTABLE"
    with pytest.raises(DBAPIError, match="immutable"):
        execute(
            db,
            "UPDATE catalog.dataset_versions SET manifest_sha256 = :m WHERE dataset_version_id = :v",
            m="0" * 64,
            v=version_id,
        )
    with pytest.raises(DBAPIError, match="immutable"):
        execute(db, "DELETE FROM catalog.dataset_files WHERE dataset_version_id = :v", v=version_id)


def test_at13_new_version_after_publish(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, version_id = new_draft(api)
    upload_files(api, db, version_id, FILES)
    assert publish(api, version_id).status_code == 200
    assert (
        api.post("b.steward", f"/datasets/{dataset_id}/versions", json={"version_label": "v2"}).status_code
        == 201
    )
    reused = api.post("b.steward", f"/datasets/{dataset_id}/versions", json={"version_label": "v1"})
    assert reused.status_code == 409 and reused.json()["error"]["code"] == "DATASET_VERSION_LABEL_EXISTS"


def test_at14_same_files_in_different_order_give_the_same_manifest(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, first = new_draft(api)
    upload_files(api, db, first, FILES)
    second = api.post("b.steward", f"/datasets/{dataset_id}/versions", json={"version_label": "v2"}).json()[
        "dataset_version_id"
    ]
    for path in reversed(list(FILES)):
        upload_files(api, db, second, {path: FILES[path]})
    manifests = [publish(api, version_id).json()["manifest_sha256"] for version_id in (first, second)]
    assert manifests[0] == manifests[1]


def test_only_owner_stewards_publish(api: CatalogApi, db: PgUrls) -> None:
    _, version_id = new_draft(api)
    upload_files(api, db, version_id, FILES)
    response = publish(api, version_id, user="b.admin")
    assert response.status_code == 403
    assert_matches_response("publishDatasetVersion", 403, response.json())
    assert publish(api, version_id, user="a.steward").status_code == 404


def test_published_version_becomes_the_latest(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, version_id = new_draft(api)
    upload_files(api, db, version_id, FILES)
    publish(api, version_id)
    body = api.get("a.researcher", f"/datasets/{dataset_id}").json()
    assert body["latest_published_version"]["dataset_version_id"] == version_id
    listed = api.get("a.researcher", f"/datasets/{dataset_id}/versions").json()["items"]
    assert [v["dataset_version_id"] for v in listed] == [version_id]
