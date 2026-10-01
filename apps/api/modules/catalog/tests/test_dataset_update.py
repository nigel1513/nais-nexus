from uuid import UUID

import pytest

from api.modules.catalog.service import dataset_update
from api.modules.catalog.tests.support import SHA_A, execute, insert_version, outbox_events, rows
from api.modules.catalog.tests.support_api import CatalogApi, assert_error, create_dataset
from api.platform.testing.contracts import assert_matches_response, assert_valid_event
from api.platform.testing.fixtures import PgUrls


def _clear_outbox(db: PgUrls) -> None:
    execute(db, "DELETE FROM platform.outbox_events")


def test_at21_controlled_to_public_emits_access_level_changed(api: CatalogApi, db: PgUrls) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    _clear_outbox(db)
    response = api.patch("b.steward", f"/datasets/{dataset_id}", json={"access_level": "PUBLIC"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert_matches_response("updateDataset", 200, body)
    assert (body["access_level"], body["policy"]["approval_required"]) == ("PUBLIC", False)
    changed = outbox_events(db, "catalog.dataset.access_level_changed.v1")
    assert len(changed) == 1
    assert_valid_event(changed[0])
    assert changed[0]["payload"]["previous_access_level"] == "CONTROLLED"
    assert changed[0]["payload"]["access_level"] == "PUBLIC"
    # approval_required flipped true -> false, which §6.4 counts as a policy change
    policy = outbox_events(db, "catalog.dataset.policy_changed.v1")
    assert len(policy) == 1
    assert_valid_event(policy[0])
    assert policy[0]["payload"]["previous"]["approval_required"] is True
    assert policy[0]["payload"]["current"]["approval_required"] is False
    assert changed[0]["correlation_id"] == policy[0]["correlation_id"]


def test_purpose_change_emits_policy_changed_only(api: CatalogApi, db: PgUrls) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    _clear_outbox(db)
    response = api.patch(
        "b.steward", f"/datasets/{dataset_id}", json={"allowed_purposes": ["EDUCATION"], "max_grant_days": 90}
    )
    assert response.status_code == 200
    assert outbox_events(db, "catalog.dataset.access_level_changed.v1") == []
    [event] = outbox_events(db, "catalog.dataset.policy_changed.v1")
    assert event["payload"]["previous"] == {
        "allowed_purposes": ["ACADEMIC_RESEARCH", "AI_TRAINING"],
        "approval_required": True,
        "max_grant_days": 180,
    }
    assert event["payload"]["current"] == {
        "allowed_purposes": ["EDUCATION"],
        "approval_required": True,
        "max_grant_days": 90,
    }


def test_noop_and_reordered_purposes_emit_no_policy_events(
    api: CatalogApi, db: PgUrls
) -> None:  # Review Focus 3
    dataset_id = create_dataset(api)["dataset_id"]
    _clear_outbox(db)
    same = {
        "access_level": "CONTROLLED",
        "allowed_purposes": ["AI_TRAINING", "ACADEMIC_RESEARCH"],
        "max_grant_days": 180,
    }
    assert api.patch("b.steward", f"/datasets/{dataset_id}", json=same).status_code == 200
    assert (
        api.patch("b.steward", f"/datasets/{dataset_id}", json={"title": "Renamed dataset"}).status_code
        == 200
    )
    assert outbox_events(db) == []
    assert rows(db, "SELECT count(*) AS n FROM catalog.index_queue")[0]["n"] == 1


def test_raising_to_sensitive_with_long_grants_is_invalid_policy(api: CatalogApi) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    response = api.patch("b.steward", f"/datasets/{dataset_id}", json={"access_level": "SENSITIVE"})
    assert response.status_code == 422
    assert_matches_response("updateDataset", 422, response.json())
    assert response.json()["error"]["code"] == "INVALID_POLICY"
    ok = api.patch(
        "b.steward", f"/datasets/{dataset_id}", json={"access_level": "SENSITIVE", "max_grant_days": 30}
    )
    assert ok.status_code == 200 and ok.json()["policy"]["max_grant_days"] == 30


def test_published_snapshot_is_not_touched_by_updates(api: CatalogApi, db: PgUrls) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    version_id = insert_version(db, UUID(dataset_id), published=True, files=[("data/a.csv", 10, SHA_A)])
    assert (
        api.patch("b.steward", f"/datasets/{dataset_id}", json={"title": "Changed later"}).status_code == 200
    )
    snapshot = rows(
        db,
        "SELECT metadata_snapshot FROM catalog.dataset_versions WHERE dataset_version_id = :v",
        v=version_id,
    )
    assert snapshot == [{"metadata_snapshot": {}}]


def test_non_steward_gets_403_and_invisible_dataset_404(api: CatalogApi) -> None:
    dataset_id = create_dataset(api, access_level="INTERNAL")["dataset_id"]
    response = api.patch("b.researcher", f"/datasets/{dataset_id}", json={"title": "Nope nope"})
    assert response.status_code == 403
    assert_matches_response("updateDataset", 403, response.json())
    assert_error(
        "updateDataset",
        api.patch("a.steward", f"/datasets/{dataset_id}", json={"title": "Nope nope"}),
        404,
        "NOT_FOUND",
    )


def test_withdrawn_dataset_can_only_be_reactivated(api: CatalogApi, db: PgUrls) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    response = api.patch("b.steward", f"/datasets/{dataset_id}", json={"status": "WITHDRAWN"})
    assert response.status_code == 200 and response.json()["status"] == "WITHDRAWN"
    assert_error(
        "updateDataset",
        api.patch("b.steward", f"/datasets/{dataset_id}", json={"title": "Edited while withdrawn"}),
        409,
        "CONFLICT",
    )
    assert_error(
        "updateDataset",
        api.patch("b.steward", f"/datasets/{dataset_id}", json={"status": "ACTIVE", "title": "Both at once"}),
        409,
        "CONFLICT",
    )
    response = api.patch("b.steward", f"/datasets/{dataset_id}", json={"status": "ACTIVE"})
    assert response.status_code == 200 and response.json()["status"] == "ACTIVE"


@pytest.mark.parametrize("body", [{}, {"title": None}, {"row_version": 3}, {"allowed_purposes": []}])
def test_invalid_patch_bodies(api: CatalogApi, body: dict[str, object]) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    response = api.patch("b.steward", f"/datasets/{dataset_id}", json=body)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"


def test_concurrent_modification_is_a_conflict(
    api: CatalogApi, db: PgUrls, monkeypatch: pytest.MonkeyPatch
) -> None:
    dataset_id = create_dataset(api)["dataset_id"]
    original = dataset_update.visible_dataset

    def racing(session, user, did, **kwargs):  # type: ignore[no-untyped-def]
        row = original(session, user, did, **kwargs)
        execute(
            db, "UPDATE catalog.datasets SET row_version = row_version + 1 WHERE dataset_id = :id", id=did
        )
        return row

    monkeypatch.setattr(dataset_update, "visible_dataset", racing)
    assert_error(
        "updateDataset",
        api.patch("b.steward", f"/datasets/{dataset_id}", json={"title": "Lost update"}),
        409,
        "CONFLICT",
    )
    title = rows(db, "SELECT title FROM catalog.datasets WHERE dataset_id = :id", id=dataset_id)[0]["title"]
    assert title == "Battery Cycling Measurements"
