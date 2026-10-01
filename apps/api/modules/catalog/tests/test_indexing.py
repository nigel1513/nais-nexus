import logging
from collections.abc import Mapping, Sequence
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import httpx
import pytest

from api.modules.catalog.reindex import reindex_all
from api.modules.catalog.search.drain import backoff_seconds, drain_index_queue
from api.modules.catalog.search.opensearch import OpenSearchIndex, SearchUnavailable
from api.modules.catalog.testing import RecordingSearchIndex
from api.modules.catalog.tests.support import SHA_A, execute, insert_version, rows
from api.modules.catalog.tests.support_api import CatalogApi, create_dataset
from api.platform import clock
from api.platform.testing.fixtures import PgUrls


class FailingSearchIndex(RecordingSearchIndex):
    def bulk(
        self, upserts: Sequence[Mapping[Any, Any]], deletes: Sequence[str], *, index: str | None = None
    ) -> None:
        raise SearchUnavailable("opensearch down")


def fetch(index: OpenSearchIndex, dataset_id: str) -> dict[str, Any] | None:
    index.refresh()
    hits = index.search({"query": {"ids": {"values": [dataset_id]}}})["hits"]["hits"]
    return hits[0]["_source"] if hits else None


def test_drain_indexes_a_new_dataset(
    search_api: CatalogApi, db: PgUrls, search_index: OpenSearchIndex
) -> None:
    dataset = create_dataset(search_api, description="x" * 400, keywords=["Battery", "cycling"])
    result = drain_index_queue(search_api.deps)
    assert (result.indexed, result.deleted, result.failed) == (1, 0, 0)
    assert rows(db, "SELECT dataset_id FROM catalog.index_queue") == []
    doc = fetch(search_index, dataset["dataset_id"])
    assert doc is not None
    assert doc["owner_organization_name"] == "Institute B"
    assert doc["has_published_version"] is False and doc["latest_version_id"] is None
    assert doc["snippet"] == "x" * 300
    assert doc["keywords"] == ["Battery", "cycling"]
    assert doc["status"] == "ACTIVE" and doc["access_level"] == "CONTROLLED"


def test_published_version_and_readiness_reach_the_document(
    search_api: CatalogApi, db: PgUrls, search_index: OpenSearchIndex
) -> None:
    dataset_id = create_dataset(search_api)["dataset_id"]
    old = insert_version(
        db,
        UUID(dataset_id),
        label="v1",
        published=True,
        files=[("a.csv", 1, SHA_A)],
        published_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    new = insert_version(
        db,
        UUID(dataset_id),
        label="v2",
        published=True,
        files=[("a.csv", 1, SHA_A)],
        published_at=datetime(2026, 2, 1, tzinfo=UTC),
    )
    execute(
        db,
        "INSERT INTO catalog.readiness_summaries (dataset_version_id, profile_id, dataset_id, validation_id, run_status,"
        " overall_status, completed_at, source_event_id) VALUES (:v, 'GENERIC_BASIC', :d, gen_random_uuid(),"
        " 'COMPLETED', 'WARNING', now(), gen_random_uuid())",
        v=new,
        d=dataset_id,
    )
    drain_index_queue(search_api.deps)
    doc = fetch(search_index, dataset_id)
    assert doc is not None
    assert (doc["latest_version_id"], doc["latest_version_label"], doc["readiness_overall"]) == (
        str(new),
        "v2",
        "WARNING",
    )
    assert doc["has_published_version"] is True and doc["published_at"].startswith("2026-02-01")
    assert str(old) != doc["latest_version_id"]


def test_withdrawn_dataset_is_removed_from_the_index(
    search_api: CatalogApi, search_index: OpenSearchIndex
) -> None:
    dataset_id = create_dataset(search_api)["dataset_id"]
    drain_index_queue(search_api.deps)
    assert fetch(search_index, dataset_id) is not None
    assert (
        search_api.patch("b.steward", f"/datasets/{dataset_id}", json={"status": "WITHDRAWN"}).status_code
        == 200
    )
    assert drain_index_queue(search_api.deps).deleted == 1
    assert fetch(search_index, dataset_id) is None


def test_failures_back_off_and_retry(api: CatalogApi, db: PgUrls, caplog: pytest.LogCaptureFixture) -> None:
    api.use(replace(api.deps, search=FailingSearchIndex()))
    dataset_id = create_dataset(api)["dataset_id"]
    now = datetime.now(UTC)
    with clock.frozen(now):
        assert drain_index_queue(api.deps).failed == 1
        assert drain_index_queue(api.deps).failed == 0  # not due yet
    [row] = rows(
        db, "SELECT attempts, next_attempt_at FROM catalog.index_queue WHERE dataset_id = :id", id=dataset_id
    )
    assert row["attempts"] == 1 and row["next_attempt_at"] == now + timedelta(seconds=backoff_seconds(1))
    execute(db, "UPDATE catalog.index_queue SET attempts = 10, next_attempt_at = now() - interval '1 second'")
    with caplog.at_level(logging.ERROR, logger="nais.catalog.index"):
        drain_index_queue(api.deps)
    assert "keeps failing" in caplog.text
    recording = RecordingSearchIndex()
    api.use(replace(api.deps, search=recording))
    with clock.frozen(datetime.now(UTC) + timedelta(seconds=600)):
        assert drain_index_queue(api.deps).indexed == 1
    assert list(recording.docs) == [dataset_id]


def test_backoff_is_capped() -> None:
    assert [backoff_seconds(n) for n in (1, 2, 3, 9, 20)] == [2.0, 4.0, 8.0, 300.0, 300.0]


def test_reindex_all_swaps_the_alias(
    search_api: CatalogApi, db: PgUrls, search_index: OpenSearchIndex, opensearch_url: str
) -> None:
    first = create_dataset(search_api)["dataset_id"]
    second = create_dataset(search_api, title="Second dataset")["dataset_id"]
    drain_index_queue(search_api.deps)
    new_index = reindex_all(search_api.deps)
    assert new_index == f"{search_index.alias}-v2"
    assert list(httpx.get(f"{opensearch_url}/_alias/{search_index.alias}").json()) == [new_index]
    assert fetch(search_index, first) is not None and fetch(search_index, second) is not None
    assert {r["dataset_id"] for r in rows(db, "SELECT dataset_id FROM catalog.index_queue")} == {
        UUID(first),
        UUID(second),
    }


def test_reindex_refuses_to_write_into_an_existing_index(
    search_api: CatalogApi, search_index: OpenSearchIndex, opensearch_url: str
) -> None:
    create_dataset(search_api)
    search_index.ensure()
    httpx.put(f"{opensearch_url}/{search_index.alias}-v2").raise_for_status()  # squatting on the next name
    with pytest.raises(SearchUnavailable):
        search_index.create_index(f"{search_index.alias}-v2", exist_ok=False)
    assert list(httpx.get(f"{opensearch_url}/_alias/{search_index.alias}").json()) == [
        f"{search_index.alias}-v1"
    ]


def test_next_index_name_does_not_treat_client_errors_as_no_indices(search_index: OpenSearchIndex) -> None:
    def bad(*_a: Any, **_k: Any) -> httpx.Response:
        return httpx.Response(401, text="unauthorized")

    search_index._request = bad  # type: ignore[method-assign]
    with pytest.raises(SearchUnavailable):
        search_index.next_index_name()
