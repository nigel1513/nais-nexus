from contextlib import nullcontext
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from api.modules.catalog.search.drain import drain_index_queue
from api.modules.catalog.tests.support import ORG_B, SHA_A, execute, insert_version, rows
from api.modules.catalog.tests.support_api import CatalogApi, create_dataset
from api.platform import clock
from api.platform.db import session_factory
from api.platform.event_bus import HandlerRegistry, registry
from api.platform.events import EventActor
from api.platform.ids import new_id
from api.platform.outbox import outbox
from api.platform.relay import RelayResult, dispatch_batch
from api.platform.testing.fixtures import PgUrls

CATALOG_EVENTS = ("readiness.validation.completed.v1", "identity.organization.created.v1")


def catalog_registry() -> HandlerRegistry:
    """Only the catalog's handlers (other modules' handlers may be registered in the same test session)."""
    local = HandlerRegistry()
    for event_type in CATALOG_EVENTS:
        for subscription in registry.handlers_for(event_type):
            if subscription.name.startswith("api.modules.catalog."):
                local.subscribe(event_type)(subscription.handler)
    return local


def emit(db: PgUrls, event_type: str, payload: dict[str, Any], at: datetime | None = None) -> None:
    with clock.frozen(at) if at else nullcontext(), session_factory(db.app)() as session, session.begin():
        outbox.write(session, event_type, payload, EventActor.system())


def relay(db: PgUrls) -> RelayResult:
    return dispatch_batch(session_factory(db.app), catalog_registry())


def readiness(
    dataset_id: str,
    version_id: UUID,
    *,
    profile: str = "TABULAR_ML_BASIC",
    overall: str | None = "FAIL",
    run_status: str = "COMPLETED",
) -> dict[str, Any]:
    return {
        "validation_id": str(new_id()),
        "dataset_id": dataset_id,
        "dataset_version_id": str(version_id),
        "owner_organization_id": str(ORG_B),
        "profile_id": profile,
        "profile_version": "1.0.0",
        "run_status": run_status,
        "overall_status": overall if run_status == "COMPLETED" else None,
        "summary": {"pass": 3, "warning": 0, "fail": 1, "not_applicable": 0},
        "validator_version": "0.1.0",
        "input_fingerprint": "f" * 64,
    }


def published_dataset(api: CatalogApi, db: PgUrls) -> tuple[str, UUID]:
    dataset_id = create_dataset(api)["dataset_id"]
    version_id = insert_version(db, UUID(dataset_id), published=True, files=[("data/a.csv", 10, SHA_A)])
    execute(db, "DELETE FROM platform.outbox_events")  # keep only the events each test emits
    return dataset_id, version_id


def overall(api: CatalogApi, dataset_id: str) -> str | None:
    value: str | None = api.get("b.steward", f"/datasets/{dataset_id}").json()["latest_published_version"][
        "readiness_overall"
    ]
    return value


def test_catalog_subscribes_to_its_two_events() -> None:
    table = registry.table()
    for event_type in CATALOG_EVENTS:
        assert any(name.startswith("api.modules.catalog.handlers.") for name in table[event_type])


def test_at19_readiness_result_reaches_search_once(search_api: CatalogApi, db: PgUrls) -> None:  # M03-AT-19
    dataset_id, version_id = published_dataset(search_api, db)
    drain_index_queue(search_api.deps)
    emit(db, "readiness.validation.completed.v1", readiness(dataset_id, version_id))
    assert relay(db).dispatched == 1
    drain_index_queue(search_api.deps)
    search_api.deps.search.refresh()
    hits = search_api.get("a.researcher", "/datasets").json()["items"]
    assert [(h["dataset_id"], h["readiness_overall"]) for h in hits] == [(dataset_id, "FAIL")]
    # at-least-once redelivery: no second claim, no new index work
    execute(db, "UPDATE platform.outbox_events SET dispatched_at = NULL")
    assert relay(db).dispatched == 1
    assert (
        rows(db, "SELECT count(*) AS n FROM catalog.processed_events WHERE handler = 'readiness_summary'")[0][
            "n"
        ]
        == 1
    )
    assert rows(db, "SELECT dataset_id FROM catalog.index_queue") == []
    assert rows(db, "SELECT overall_status FROM catalog.readiness_summaries") == [{"overall_status": "FAIL"}]


def test_older_events_are_ignored(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, version_id = published_dataset(api, db)
    now = datetime.now(UTC)
    emit(db, "readiness.validation.completed.v1", readiness(dataset_id, version_id, overall="PASS"), at=now)
    emit(
        db,
        "readiness.validation.completed.v1",
        readiness(dataset_id, version_id, overall="FAIL"),
        at=now - timedelta(minutes=5),
    )
    relay(db)
    assert overall(api, dataset_id) == "PASS"


def test_failed_run_does_not_erase_completed_result(api: CatalogApi, db: PgUrls) -> None:  # Review Focus 5
    dataset_id, version_id = published_dataset(api, db)
    now = datetime.now(UTC)
    emit(
        db, "readiness.validation.completed.v1", readiness(dataset_id, version_id, overall="WARNING"), at=now
    )
    emit(
        db,
        "readiness.validation.completed.v1",
        readiness(dataset_id, version_id, run_status="FAILED"),
        at=now + timedelta(minutes=1),
    )
    relay(db)
    assert overall(api, dataset_id) == "WARNING"


def test_generic_profile_is_the_fallback_and_failed_runs_count_as_none(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, version_id = published_dataset(api, db)
    emit(
        db,
        "readiness.validation.completed.v1",
        readiness(dataset_id, version_id, profile="TABULAR_ML_BASIC", run_status="FAILED"),
    )
    relay(db)
    assert overall(api, dataset_id) is None
    emit(
        db,
        "readiness.validation.completed.v1",
        readiness(dataset_id, version_id, profile="GENERIC_BASIC", overall="PASS"),
    )
    relay(db)
    assert overall(api, dataset_id) == "PASS"
    emit(
        db,
        "readiness.validation.completed.v1",
        readiness(dataset_id, version_id, profile="TABULAR_ML_BASIC", overall="FAIL"),
    )
    relay(db)
    assert overall(api, dataset_id) == "FAIL"
    version = api.get("a.researcher", f"/dataset-versions/{version_id}").json()
    assert version["readiness_overall"] == "FAIL"


def test_organization_created_requeues_its_datasets(api: CatalogApi, db: PgUrls) -> None:
    first = create_dataset(api)["dataset_id"]
    second = create_dataset(api)["dataset_id"]
    create_dataset(api, user="a.steward")
    execute(db, "DELETE FROM catalog.index_queue")
    execute(db, "DELETE FROM platform.outbox_events")
    emit(
        db,
        "identity.organization.created.v1",
        {
            "organization_id": str(ORG_B),
            "code": "inst-b",
            "name": "Institute B",
            "type": "RESEARCH_INSTITUTE",
        },
    )
    assert relay(db).dispatched == 1
    assert {r["dataset_id"] for r in rows(db, "SELECT dataset_id FROM catalog.index_queue")} == {
        UUID(first),
        UUID(second),
    }


def test_completed_result_wins_over_a_later_failed_one_in_any_order(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, version_id = published_dataset(api, db)
    now = datetime.now(UTC)
    emit(
        db,
        "readiness.validation.completed.v1",
        readiness(dataset_id, version_id, run_status="FAILED"),
        at=now + timedelta(minutes=1),
    )
    emit(db, "readiness.validation.completed.v1", readiness(dataset_id, version_id, overall="PASS"), at=now)
    relay(db)
    assert overall(api, dataset_id) == "PASS"


def test_equal_timestamp_tie_and_stale_events_enqueue_nothing(api: CatalogApi, db: PgUrls) -> None:
    dataset_id, version_id = published_dataset(api, db)
    at = datetime.now(UTC)
    emit(db, "readiness.validation.completed.v1", readiness(dataset_id, version_id, overall="PASS"), at=at)
    relay(db)
    execute(db, "DELETE FROM catalog.index_queue")
    emit(db, "readiness.validation.completed.v1", readiness(dataset_id, version_id, overall="FAIL"), at=at)
    emit(
        db,
        "readiness.validation.completed.v1",
        readiness(dataset_id, version_id, overall="FAIL"),
        at=at - timedelta(minutes=5),
    )
    emit(
        db,
        "readiness.validation.completed.v1",
        readiness(dataset_id, version_id, run_status="FAILED"),
        at=at + timedelta(minutes=1),
    )
    relay(db)
    assert overall(api, dataset_id) == "PASS"
    assert rows(db, "SELECT dataset_id FROM catalog.index_queue") == []
