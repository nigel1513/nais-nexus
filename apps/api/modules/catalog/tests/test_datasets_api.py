from dataclasses import replace
from uuid import UUID, uuid4

import pytest

from api.modules.catalog.testing import memory_registry
from api.modules.catalog.tests.support import (
    ORG_A,
    ORG_B,
    SHA_A,
    execute,
    insert_version,
    outbox_events,
    rows,
)
from api.modules.catalog.tests.support_api import (
    USERS,
    CatalogApi,
    assert_error,
    create_dataset,
    dataset_body,
)
from api.platform.testing.contracts import assert_matches_response, assert_valid_event
from api.platform.testing.fixtures import PgUrls


def test_at01_steward_creates_controlled_dataset(api: CatalogApi, db: PgUrls) -> None:
    response = api.post("b.steward", "/datasets", json=dataset_body())
    assert response.status_code == 201, response.text
    body = response.json()
    assert_matches_response("createDataset", 201, body)
    assert body["policy"] == {
        "dataset_id": body["dataset_id"],
        "owner_organization_id": str(ORG_B),
        "access_level": "CONTROLLED",
        "allowed_purposes": ["ACADEMIC_RESEARCH", "AI_TRAINING"],
        "approval_required": True,
        "max_grant_days": 180,
    }
    assert body["owner_organization_name"] == "Institute B"
    assert body["status"] == "ACTIVE" and body["latest_published_version"] is None
    assert body["created_by"] == str(USERS["b.steward"].user_id)
    events = outbox_events(db, "catalog.dataset.created.v1")
    assert len(events) == 1
    assert_valid_event(events[0])
    assert events[0]["payload"] == {
        "dataset_id": body["dataset_id"],
        "owner_organization_id": str(ORG_B),
        "title": body["title"],
        "access_level": "CONTROLLED",
    }
    assert events[0]["actor"] == {
        "type": "USER",
        "user_id": str(USERS["b.steward"].user_id),
        "organization_id": str(ORG_B),
    }
    assert [r["dataset_id"] for r in rows(db, "SELECT dataset_id FROM catalog.index_queue")] == [
        UUID(body["dataset_id"])
    ]


@pytest.mark.parametrize("user", ["b.researcher", "b.admin", "platform.admin"])
def test_at02_only_the_owner_org_steward_can_create(api: CatalogApi, db: PgUrls, user: str) -> None:
    response = api.post(user, "/datasets", json=dataset_body())
    assert response.status_code == 403
    assert_matches_response("createDataset", 403, response.json())
    assert response.json()["error"]["code"] == "FORBIDDEN"
    assert outbox_events(db) == []
    assert rows(db, "SELECT dataset_id FROM catalog.datasets") == []


def test_at03_steward_of_another_org_is_forbidden(api: CatalogApi) -> None:
    response = api.post("a.steward", "/datasets", json=dataset_body(ORG_B))
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "FORBIDDEN"


def test_at04_sensitive_with_60_days_is_invalid_policy(api: CatalogApi, db: PgUrls) -> None:
    response = api.post(
        "b.steward", "/datasets", json=dataset_body(access_level="SENSITIVE", max_grant_days=60)
    )
    assert response.status_code == 422
    assert_matches_response("createDataset", 422, response.json())
    assert response.json()["error"]["code"] == "INVALID_POLICY"
    assert outbox_events(db) == []


def test_sensitive_defaults_to_30_days_and_public_needs_no_approval(api: CatalogApi) -> None:
    sensitive = create_dataset(api, access_level="SENSITIVE")
    assert (sensitive["policy"]["max_grant_days"], sensitive["policy"]["approval_required"]) == (30, True)
    public = create_dataset(api, access_level="PUBLIC", max_grant_days=365)
    assert (public["policy"]["max_grant_days"], public["policy"]["approval_required"]) == (365, False)


def test_organization_without_storage_is_rejected(api: CatalogApi) -> None:
    api.use(replace(api.deps, storage=memory_registry(("nais", "inst-a"))))
    response = api.post("b.steward", "/datasets", json=dataset_body())
    assert response.status_code == 422
    assert_matches_response("createDataset", 422, response.json())
    assert response.json()["error"]["details"]["fields"] == [
        {"field": "owner_organization_id", "reason": "STORAGE_NOT_CONFIGURED"}
    ]


@pytest.mark.parametrize(
    "overrides",
    [
        {"title": "ab"},
        {"unexpected": 1},
        {"domain": None},
        {"allowed_purposes": ["AI_TRAINING", "AI_TRAINING"]},
        {"allowed_purposes": []},
        {"keywords": ["x" * 51]},
        {"contact_email": "not-an-email"},
        {"license": ""},
    ],
)
def test_invalid_bodies_are_validation_failed(api: CatalogApi, overrides: dict[str, object]) -> None:
    response = api.post("b.steward", "/datasets", json=dataset_body(**overrides))
    assert response.status_code == 422
    assert_matches_response("createDataset", 422, response.json())
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"


def test_missing_token_is_unauthenticated(api: CatalogApi) -> None:
    assert_error("createDataset", api.post(None, "/datasets", json=dataset_body()), 401, "UNAUTHENTICATED")


def test_at15_internal_dataset_is_visible_to_owner_org_only(api: CatalogApi) -> None:  # M03-AT-15 (GET)
    dataset_id = create_dataset(api, access_level="INTERNAL")["dataset_id"]
    for user in ("b.researcher", "b.steward", "b.admin", "platform.admin"):
        response = api.get(user, f"/datasets/{dataset_id}")
        assert response.status_code == 200, user
        assert_matches_response("getDataset", 200, response.json())
    response = api.get("a.researcher", f"/datasets/{dataset_id}")
    assert response.status_code == 404
    assert_matches_response("getDataset", 404, response.json())


def test_at17_controlled_dataset_is_visible_to_others_only_once_published(
    api: CatalogApi, db: PgUrls
) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    assert api.get("a.researcher", f"/datasets/{dataset_id}").status_code == 404
    version_id = insert_version(db, UUID(dataset_id), published=True, files=[("data/a.csv", 10, SHA_A)])
    response = api.get("a.researcher", f"/datasets/{dataset_id}")
    assert response.status_code == 200
    body = response.json()
    assert_matches_response("getDataset", 200, body)
    latest = body["latest_published_version"]
    assert (latest["dataset_version_id"], latest["status"], latest["readiness_overall"]) == (
        str(version_id),
        "PUBLISHED",
        None,
    )


def test_internal_published_dataset_stays_hidden_from_other_orgs(api: CatalogApi, db: PgUrls) -> None:
    dataset_id = create_dataset(api, access_level="INTERNAL")["dataset_id"]
    insert_version(db, UUID(dataset_id), published=True, files=[("data/a.csv", 10, SHA_A)])
    assert api.get("a.researcher", f"/datasets/{dataset_id}").status_code == 404


def test_withdrawn_dataset_is_visible_only_to_the_owner_org(api: CatalogApi, db: PgUrls) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    insert_version(db, UUID(dataset_id), published=True, files=[("data/a.csv", 10, SHA_A)])
    execute(db, "UPDATE catalog.datasets SET status = 'WITHDRAWN' WHERE dataset_id = :id", id=dataset_id)
    assert api.get("a.researcher", f"/datasets/{dataset_id}").status_code == 404
    response = api.get("b.steward", f"/datasets/{dataset_id}")
    assert response.status_code == 200 and response.json()["status"] == "WITHDRAWN"


def test_policy_view_follows_dataset_visibility(api: CatalogApi, db: PgUrls) -> None:
    created = create_dataset(api)
    response = api.get("b.researcher", f"/datasets/{created['dataset_id']}/policy")
    assert response.status_code == 200
    assert_matches_response("getDatasetPolicy", 200, response.json())
    assert response.json() == created["policy"]
    response = api.get("a.researcher", f"/datasets/{created['dataset_id']}/policy")
    assert response.status_code == 404
    assert_matches_response("getDatasetPolicy", 404, response.json())


def test_unknown_dataset_is_404(api: CatalogApi) -> None:
    assert api.get("b.steward", f"/datasets/{uuid4()}").status_code == 404


def test_datasets_of_other_orgs_are_created_in_their_own_org_only(api: CatalogApi) -> None:
    created = create_dataset(api, user="a.steward")
    assert created["owner_organization_id"] == str(ORG_A)
    assert created["owner_organization_name"] == "Institute A"
