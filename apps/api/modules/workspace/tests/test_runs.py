"""Recipe runs: start, the worker job, derived outputs with lineage, failures and the sweeper
(spec §5.3–5.4; openapi startRun/listRuns/getRun)."""

import io
import json
from dataclasses import replace
from datetime import timedelta
from typing import Any
from uuid import UUID

import pyarrow.parquet as pq
import pytest
from dramatiq.brokers.stub import StubBroker

from api.modules.catalog.public import StorageUnavailable
from api.modules.workspace import MODULE, jobs
from api.modules.workspace.tests.conftest import WorkspaceApi, World, outbox, sql
from api.modules.workspace.tests.fakes import USERS
from api.modules.workspace.tests.recipe_world import Recipes, build, create, error_code, tabular_version
from api.platform import clock
from api.platform.ids import new_id
from api.platform.scheduler import Scheduler
from api.platform.testing.contracts import assert_matches_response, assert_valid_event
from api.platform.testing.fixtures import PgUrls


@pytest.fixture
def s(api: WorkspaceApi, world: World, db: PgUrls) -> Recipes:
    built = build(api, world)
    sql(db, "DELETE FROM platform.outbox_events")
    return built


def queued() -> list[dict[str, Any]]:
    broker = jobs.run_recipe_actor.broker
    assert isinstance(broker, StubBroker)
    return [json.loads(m) for m in list(broker.queues[jobs.QUEUE].queue)]


def start(api: WorkspaceApi, s: Recipes, recipe_id: str, user: str = "a.researcher") -> Any:
    return api.post(user, f"{s.base}/recipes/{recipe_id}/runs")


def started(api: WorkspaceApi, s: Recipes, **overrides: Any) -> tuple[str, str]:
    recipe = create(api, s, **overrides)
    assert recipe.status_code == 201, recipe.text
    run = start(api, s, recipe.json()["recipe_id"])
    assert run.status_code == 202, run.text
    return recipe.json()["recipe_id"], run.json()["run_id"]


def events(db: PgUrls, kind: str) -> list[dict[str, Any]]:
    return [e for e in outbox(db) if e["event_type"] == kind]


def result_table(world: World, output: dict[str, Any]) -> Any:
    [(org, key)] = [k for k in world.storage.objects if output["output_id"] in k[1]]
    return pq.read_table(io.BytesIO(world.storage.objects[(org, key)]))


# ---------------------------------------------------------------- start


def test_start_pins_versions_and_queues_after_commit(api: WorkspaceApi, s: Recipes, db: PgUrls) -> None:
    recipe_id, run_id = started(api, s)
    run = api.get("a.viewer", f"{s.base}/runs/{run_id}")
    assert run.status_code == 200
    assert_matches_response("getRun", 200, run.json())
    body = run.json()
    assert (body["status"], body["recipe_version"], body["recipe_id"]) == ("QUEUED", 1, recipe_id)
    assert body["started_by"] == str(USERS["a.researcher"].user_id)
    assert body["started_at"] is None and body["output_id"] is None and body["error"] is None

    [message] = queued()
    assert (message["actor_name"], message["args"]) == ("workspace.run_recipe", [run_id])
    pinned = sql(
        db,
        "SELECT input_id, dataset_version_id, dataset_title, version_label FROM workspace.run_inputs ORDER BY position",
    )
    assert [
        (str(p["input_id"]), str(p["dataset_version_id"]), p["dataset_title"], p["version_label"])
        for p in pinned
    ] == [
        (str(s.cells_input), str(s.cells_v1.dataset_version_id), "셀 측정", "v1"),
        (str(s.specs_input), str(s.specs_v1.dataset_version_id), "셀 사양", "v1"),
    ]


def test_start_response_matches_the_contract(api: WorkspaceApi, s: Recipes) -> None:
    recipe = create(api, s).json()
    response = start(api, s, recipe["recipe_id"])
    assert_matches_response("startRun", 202, response.json())


def test_one_active_run_per_recipe(api: WorkspaceApi, s: Recipes) -> None:
    recipe_id, _ = started(api, s)
    again = start(api, s, recipe_id)
    assert again.status_code == 409 and error_code(again) == "RUN_NOT_ALLOWED"
    assert len(queued()) == 1


def test_start_refusals(api: WorkspaceApi, world: World, s: Recipes) -> None:
    recipe_id = create(api, s).json()["recipe_id"]
    assert error_code(start(api, s, recipe_id, user="a.viewer")) == "FORBIDDEN"
    assert start(api, s, str(new_id())).status_code == 404

    world.grants.revoke(USERS["a.researcher"], s.specs.dataset_id)
    lapsed = start(api, s, recipe_id)
    assert lapsed.status_code == 409 and error_code(lapsed) == "INPUT_ACCESS_LAPSED"
    assert lapsed.json()["error"]["details"] == {"input_ids": [str(s.specs_input)]}
    world.grants.grant(USERS["a.researcher"], s.specs.dataset_id)

    world.catalog.versions[s.cells_v1.dataset_version_id] = replace(s.cells_v1, status="WITHDRAWN")
    withdrawn = start(api, s, recipe_id)
    assert withdrawn.status_code == 409 and error_code(withdrawn) == "RUN_NOT_ALLOWED"

    world.projects.archived.add(s.project_id)
    assert error_code(start(api, s, recipe_id)) == "PROJECT_ARCHIVED"
    assert queued() == []


def test_start_with_a_removed_input_is_recipe_invalid(api: WorkspaceApi, s: Recipes) -> None:
    recipe_id = create(api, s).json()["recipe_id"]
    assert api.delete("a.researcher", f"{s.base}/inputs/{s.specs_input}").status_code == 204
    response = start(api, s, recipe_id)
    assert response.status_code == 422 and error_code(response) == "RECIPE_INVALID"


# ---------------------------------------------------------------- the worker


def test_run_produces_a_derived_dataset_with_lineage(
    api: WorkspaceApi, world: World, s: Recipes, db: PgUrls
) -> None:
    recipe_id, run_id = started(api, s)
    assert jobs.run_recipe(UUID(run_id)) == "SUCCEEDED"

    run = api.get("a.researcher", f"{s.base}/runs/{run_id}").json()
    assert_matches_response("getRun", 200, run)
    assert run["status"] == "SUCCEEDED"
    assert (run["input_rows"], run["output_rows"]) == (7, 3)
    assert run["started_at"] is not None and run["finished_at"] is not None and run["error"] is None

    output = api.get("a.viewer", f"{s.base}/outputs/{run['output_id']}")
    assert output.status_code == 200, output.text
    assert_matches_response("getOutput", 200, output.json())
    out = output.json()
    assert out["kind"] == "DERIVED_DATASET"
    assert out["title"] == "고온 구간 평균 용량 (v1)"
    assert out["access_level"] == "CONTROLLED"  # strictest input
    assert out["produced_by_run_id"] == run_id
    assert out["lineage"] == {
        "inputs": [
            {
                "dataset_id": str(s.cells.dataset_id),
                "dataset_title": "셀 측정",
                "dataset_version_id": str(s.cells_v1.dataset_version_id),
                "version_label": "v1",
            },
            {
                "dataset_id": str(s.specs.dataset_id),
                "dataset_title": "셀 사양",
                "dataset_version_id": str(s.specs_v1.dataset_version_id),
                "version_label": "v1",
            },
        ],
        "recipe_id": recipe_id,
        "recipe_version": 1,
        "run_id": run_id,
    }
    [file] = out["files"]
    assert (file["name"], file["media_type"]) == ("result.parquet", "application/vnd.apache.parquet")
    stored = world.storage.objects[
        ("inst-a", f"workspace/{s.project_id}/outputs/{out['output_id']}/result.parquet")
    ]
    assert file["size_bytes"] == len(stored)
    table = result_table(world, out)
    assert table.to_pylist() == [
        {"cell_id": "C-01", "capacity_mah_mean": 2850.5, "chemistry": "NMC"},
        {"cell_id": "C-02", "capacity_mah_mean": 2700.0, "chemistry": "LFP"},
        {"cell_id": "C-03", "capacity_mah_mean": None, "chemistry": None},
    ]

    [succeeded] = events(db, "workspace.run.succeeded.v1")
    [created] = events(db, "workspace.output.created.v1")
    for event in (succeeded, created):
        assert_valid_event(event)
        assert event["actor"]["user_id"] == str(USERS["a.researcher"].user_id)
    assert succeeded["payload"]["output_id"] == out["output_id"]
    assert (succeeded["payload"]["input_rows"], succeeded["payload"]["output_rows"]) == (7, 3)
    assert created["payload"]["kind"] == "DERIVED_DATASET" and created["payload"]["run_id"] == run_id
    assert created["payload"]["lineage_dataset_version_ids"] == [
        str(s.cells_v1.dataset_version_id),
        str(s.specs_v1.dataset_version_id),
    ]
    listed = api.get("a.researcher", f"{s.base}/outputs", params={"kind": "DERIVED_DATASET"}).json()
    assert [o["output_id"] for o in listed["items"]] == [out["output_id"]]
    assert jobs.run_recipe(UUID(run_id)) == "SKIPPED"  # duplicate delivery


def test_run_executes_the_pinned_recipe_and_input_versions(
    api: WorkspaceApi, world: World, s: Recipes
) -> None:
    recipe_id, run_id = started(api, s)
    # after the start: a new recipe version and a new input version
    url = f"{s.base}/recipes/{recipe_id}"
    saved = api.put("a.researcher", url, json=s.body(steps=[]), headers={"If-Match": "1"})
    assert saved.status_code == 200, saved.text
    v2 = tabular_version(
        world, s.cells, "v2", "cells.csv", b"cell_id,temperature_c,capacity_mah\nC-09,99,1\n"
    )
    moved = api.patch(
        "a.researcher",
        f"{s.base}/inputs/{s.cells_input}",
        json={"dataset_version_id": str(v2.dataset_version_id)},
    )
    assert moved.status_code == 200, moved.text

    assert jobs.run_recipe(UUID(run_id)) == "SUCCEEDED"
    run = api.get("a.researcher", f"{s.base}/runs/{run_id}").json()
    out = api.get("a.researcher", f"{s.base}/outputs/{run['output_id']}").json()
    assert out["lineage"]["recipe_version"] == 1
    assert out["lineage"]["inputs"][0]["version_label"] == "v1"
    assert result_table(world, out).column_names == ["cell_id", "capacity_mah_mean", "chemistry"]


def failed(api: WorkspaceApi, s: Recipes, run_id: str) -> str:
    run = api.get("a.researcher", f"{s.base}/runs/{run_id}").json()
    assert run["status"] == "FAILED" and run["output_id"] is None and run["finished_at"] is not None
    error: str = run["error"]
    assert len(error) <= 500
    return error


def test_cast_failure_fails_the_run_without_data_values(
    api: WorkspaceApi, world: World, s: Recipes, db: PgUrls
) -> None:
    _, run_id = started(
        api,
        s,
        input_ids=[str(s.cells_input)],
        steps=[{"type": "cast_type", "column": "cell_id", "to": "int"}],
    )
    assert jobs.run_recipe(UUID(run_id)) == "FAILED"
    error = failed(api, s, run_id)
    assert error.startswith("RECIPE_INVALID: Step 1 (cast_type)")
    assert "C-0" not in error and "Traceback" not in error
    [event] = events(db, "workspace.run.failed.v1")
    assert_valid_event(event)
    assert event["payload"]["error"] == error and event["payload"]["recipe_version"] == 1
    assert world.storage.objects == {}
    assert sql(db, "SELECT count(*) AS n FROM workspace.outputs") == [{"n": 0}]


def test_access_lapsing_after_start_fails_the_run(api: WorkspaceApi, world: World, s: Recipes) -> None:
    _, run_id = started(api, s)
    world.grants.revoke(USERS["a.researcher"], s.specs.dataset_id)
    reads = len(world.reader.opened)
    assert jobs.run_recipe(UUID(run_id)) == "FAILED"
    assert failed(api, s, run_id).startswith("INPUT_ACCESS_LAPSED")
    assert len(world.reader.opened) == reads  # nothing was read


def test_row_limit(api: WorkspaceApi, s: Recipes, monkeypatch: pytest.MonkeyPatch) -> None:
    _, run_id = started(api, s)
    monkeypatch.setattr(jobs._SETTINGS, "workspace_max_rows", 4)
    assert jobs.run_recipe(UUID(run_id)) == "FAILED"
    assert failed(api, s, run_id) == "INPUT_TOO_LARGE: input '셀 측정' v1: The input has more than 4 rows."


def test_input_byte_limit(api: WorkspaceApi, s: Recipes, monkeypatch: pytest.MonkeyPatch) -> None:
    _, run_id = started(api, s)
    monkeypatch.setattr(jobs._SETTINGS, "workspace_max_input_bytes", 10)
    assert jobs.run_recipe(UUID(run_id)) == "FAILED"
    assert failed(api, s, run_id).startswith("INPUT_TOO_LARGE")


def test_storage_outage_is_retried_then_fails(
    api: WorkspaceApi, world: World, s: Recipes, db: PgUrls
) -> None:
    _, run_id = started(api, s)
    world.reader.fail_with = StorageUnavailable("down")
    for attempt in (1, 2):
        with pytest.raises(jobs.RetryableInfraError):
            jobs.run_recipe(UUID(run_id))
        [row] = sql(db, "SELECT status, attempt FROM workspace.runs")
        assert row == {"status": "QUEUED", "attempt": attempt}
    assert jobs.run_recipe(UUID(run_id)) == "FAILED"
    assert failed(api, s, run_id) == "STORAGE_UNAVAILABLE: StorageUnavailable after 3 attempts"


def test_upload_outage_is_retried(api: WorkspaceApi, world: World, s: Recipes, db: PgUrls) -> None:
    from api.platform.errors import ApiError

    _, run_id = started(api, s)
    world.storage.fail_put = ApiError("DEPENDENCY_UNAVAILABLE", "Storage is unavailable.")
    with pytest.raises(jobs.RetryableInfraError):
        jobs.run_recipe(UUID(run_id))
    world.storage.fail_put = None
    assert jobs.run_recipe(UUID(run_id)) == "SUCCEEDED"
    assert sql(db, "SELECT attempt FROM workspace.runs") == [{"attempt": 2}]


def test_unexpected_errors_fail_with_the_type_only(
    api: WorkspaceApi, s: Recipes, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, run_id = started(api, s)

    def boom(*_: Any, **__: Any) -> Any:
        raise ValueError("secret cell value C-01")

    monkeypatch.setattr(jobs.steps, "apply", boom)
    assert jobs.run_recipe(UUID(run_id)) == "FAILED"
    assert failed(api, s, run_id) == "INTERNAL_ERROR: ValueError"


def test_input_without_a_table_at_run_time(api: WorkspaceApi, world: World, s: Recipes) -> None:
    _, run_id = started(api, s)
    world.reader.data.clear()  # objects gone from storage
    assert jobs.run_recipe(UUID(run_id)) == "FAILED"
    assert failed(api, s, run_id).startswith("INPUT_UNAVAILABLE")


def test_timeout_fails_the_run(api: WorkspaceApi, s: Recipes, monkeypatch: pytest.MonkeyPatch) -> None:
    from dramatiq.middleware import TimeLimitExceeded

    _, run_id = started(api, s)

    def slow(*_: Any, **__: Any) -> Any:
        raise TimeLimitExceeded()

    monkeypatch.setattr(jobs.steps, "apply", slow)
    jobs.run_recipe_actor.fn(run_id)
    assert failed(api, s, run_id).startswith("RUN_TIMEOUT")


# ---------------------------------------------------------------- reads


def test_list_runs_newest_first_with_filters(api: WorkspaceApi, s: Recipes) -> None:
    first_recipe, first_run = started(api, s)
    jobs.run_recipe(UUID(first_run))
    _, second_run = started(api, s, name="두 번째")
    page = api.get("a.viewer", f"{s.base}/runs")
    assert page.status_code == 200
    assert_matches_response("listRuns", 200, page.json())
    assert [r["run_id"] for r in page.json()["items"]] == [second_run, first_run]
    only = api.get("a.viewer", f"{s.base}/runs", params={"recipe_id": first_recipe}).json()["items"]
    assert [r["run_id"] for r in only] == [first_run]
    queued_only = api.get(
        "a.viewer", f"{s.base}/runs", params=[("status", "QUEUED"), ("status", "RUNNING")]
    ).json()
    assert [r["run_id"] for r in queued_only["items"]] == [second_run]
    one = api.get("a.viewer", f"{s.base}/runs", params={"limit": 1}).json()
    assert one["page"]["has_more"] is True
    rest = api.get(
        "a.viewer", f"{s.base}/runs", params={"limit": 1, "cursor": one["page"]["next_cursor"]}
    ).json()
    assert [r["run_id"] for r in rest["items"]] == [first_run]
    assert api.get("b.researcher", f"{s.base}/runs").status_code == 404
    assert api.get("a.viewer", f"{s.base}/runs/{new_id()}").status_code == 404
    assert api.get("a.viewer", f"{s.base}/runs", params={"status": "DONE"}).status_code == 422


# ---------------------------------------------------------------- sweeper / worker registration


def test_sweeper_fails_stale_runs(api: WorkspaceApi, s: Recipes, db: PgUrls) -> None:
    _, stale = started(api, s)
    _, fresh = started(api, s, name="새 레시피")
    old = clock.now() - timedelta(hours=2)
    sql(db, "UPDATE workspace.runs SET queued_at = :at WHERE run_id = :id", at=old, id=stale)
    assert jobs.sweep_stale() == 1
    assert failed(api, s, stale) == "STALE_RUN: no progress within the allowed time"
    assert api.get("a.researcher", f"{s.base}/runs/{fresh}").json()["status"] == "QUEUED"
    [event] = events(db, "workspace.run.failed.v1")
    assert_valid_event(event)
    assert jobs.run_recipe(UUID(stale)) == "SKIPPED"


def test_worker_registration() -> None:
    scheduler = Scheduler()
    jobs.register_worker(jobs.run_recipe_actor.broker, scheduler)
    assert jobs.run_recipe_actor.queue_name == "workspace"
    assert jobs.run_recipe_actor.actor_name == "workspace.run_recipe"
    assert MODULE.dedicated_queues == {"workspace": 1}
    assert MODULE.register_worker is jobs.register_worker
    with pytest.raises(RuntimeError, match="broker"):
        jobs.register_worker(StubBroker(), Scheduler())


def test_database_rejects_inconsistent_runs(api: WorkspaceApi, s: Recipes, db: PgUrls) -> None:
    from sqlalchemy.exc import IntegrityError

    _, run_id = started(api, s)
    insert = (
        "INSERT INTO workspace.runs (run_id, project_id, recipe_id, recipe_version, status, started_by,"
        " started_by_organization_id) SELECT :id, project_id, recipe_id, recipe_version, :status, started_by,"
        " started_by_organization_id FROM workspace.runs WHERE run_id = :run"
    )
    with pytest.raises(IntegrityError, match="uq_runs_one_active_per_recipe"):
        sql(db, insert, id=new_id(), status="RUNNING", run=run_id)
    with pytest.raises(IntegrityError, match="ck_runs_output"):
        sql(db, "UPDATE workspace.runs SET status = 'SUCCEEDED', finished_at = now()")
    with pytest.raises(IntegrityError, match="ck_runs_error_length"):
        sql(db, "UPDATE workspace.runs SET status = 'FAILED', finished_at = now(), error = repeat('x', 501)")
    with pytest.raises(IntegrityError, match="ck_runs_finished"):
        sql(db, "UPDATE workspace.runs SET status = 'FAILED', error = 'x'")
    with pytest.raises(IntegrityError, match="fk_runs_recipe_version"):
        sql(db, "UPDATE workspace.runs SET recipe_version = 9")
