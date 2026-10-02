"""Recipes and previews (spec §5.3; openapi listRecipes/createRecipe/getRecipe/updateRecipe/deleteRecipe/previewRecipe)."""

from typing import Any

import pytest

from api.modules.catalog.public import StorageUnavailable
from api.modules.workspace.recipes import reader
from api.modules.workspace.tests.conftest import WorkspaceApi, World, outbox, sql
from api.modules.workspace.tests.fakes import USERS
from api.modules.workspace.tests.recipe_world import Recipes, build, create, error_code, tabular_version
from api.platform.ids import new_id
from api.platform.testing.contracts import assert_matches_response, assert_valid_event
from api.platform.testing.fixtures import PgUrls


@pytest.fixture
def s(api: WorkspaceApi, world: World, db: PgUrls) -> Recipes:
    built = build(api, world)
    sql(db, "DELETE FROM platform.outbox_events")  # only the recipe events matter below
    return built


def recipe_events(db: PgUrls) -> list[dict[str, Any]]:
    return [e for e in outbox(db) if e["event_type"] == "workspace.recipe.saved.v1"]


# ---------------------------------------------------------------- create / read


def test_create_recipe_is_version_1_and_emits_saved(api: WorkspaceApi, s: Recipes, db: PgUrls) -> None:
    response = create(api, s)
    assert response.status_code == 201, response.text
    assert_matches_response("createRecipe", 201, response.json())
    body = response.json()
    assert body["version"] == 1
    assert body["input_ids"] == [str(s.cells_input), str(s.specs_input)]
    assert body["steps"][0] == {"type": "filter_rows", "column": "temperature_c", "op": "ge", "value": 40}
    assert body["updated_by"] == str(USERS["a.researcher"].user_id)

    [event] = recipe_events(db)
    assert_valid_event(event)
    assert event["payload"] == {
        "project_id": str(s.project_id),
        "actor_id": str(USERS["a.researcher"].user_id),
        "occurred_at": event["payload"]["occurred_at"],
        "recipe_id": body["recipe_id"],
        "recipe_name": "고온 구간 평균 용량",
        "recipe_version": 1,
        "input_ids": body["input_ids"],
        "step_count": 4,
    }

    got = api.get("a.viewer", f"{s.base}/recipes/{body['recipe_id']}")
    assert got.status_code == 200 and got.json() == body
    assert_matches_response("getRecipe", 200, got.json())
    listed = api.get("a.viewer", f"{s.base}/recipes")
    assert listed.status_code == 200
    assert_matches_response("listRecipes", 200, listed.json())
    assert [r["recipe_id"] for r in listed.json()["items"]] == [body["recipe_id"]]


def test_reads_are_for_project_members_only(api: WorkspaceApi, s: Recipes) -> None:
    recipe_id = create(api, s).json()["recipe_id"]
    assert api.get("b.researcher", f"{s.base}/recipes").status_code == 404
    assert api.get("b.researcher", f"{s.base}/recipes/{recipe_id}").status_code == 404
    assert api.get("a.researcher", f"{s.base}/recipes/{new_id()}").status_code == 404
    assert api.get(None, f"{s.base}/recipes").status_code == 401


def test_writers_only(api: WorkspaceApi, world: World, s: Recipes) -> None:
    assert error_code(create(api, s, user="a.viewer")) == "FORBIDDEN"
    assert error_code(create(api, s, user="b.researcher")) == "FORBIDDEN"
    world.projects.archived.add(s.project_id)
    response = create(api, s)
    assert response.status_code == 403  # createRecipe lists no 409


# ---------------------------------------------------------------- validation


def invalid(response: Any) -> dict[str, Any]:
    assert response.status_code == 422, response.text
    assert error_code(response) == "RECIPE_INVALID"
    details: dict[str, Any] = response.json()["error"]["details"]
    return details


def test_unknown_column_names_the_step(api: WorkspaceApi, s: Recipes) -> None:
    steps = s.steps()
    steps[3] = {"type": "sort", "by": ["capacity_mah"], "descending": False}  # aggregated away
    details = invalid(create(api, s, steps=steps))
    assert details == {"step_index": 3, "reason": "UNKNOWN_COLUMN", "column": "capacity_mah"}


def test_type_mismatch(api: WorkspaceApi, s: Recipes) -> None:
    steps = [{"type": "filter_rows", "column": "cell_id", "op": "gt", "value": 3}]
    assert invalid(create(api, s, steps=steps))["reason"] == "TYPE_MISMATCH"
    steps = [{"type": "aggregate", "group_by": [], "metrics": [{"column": "cell_id", "fn": "mean"}]}]
    assert invalid(create(api, s, steps=steps)) == {
        "step_index": 0,
        "reason": "TYPE_MISMATCH",
        "column": "cell_id",
    }


def test_join_input_must_be_a_recipe_input(api: WorkspaceApi, s: Recipes) -> None:
    details = invalid(create(api, s, input_ids=[str(s.cells_input)]))
    assert details == {"step_index": 2, "reason": "UNKNOWN_INPUT", "input_id": str(s.specs_input)}


def test_inputs_must_be_live_project_inputs(api: WorkspaceApi, s: Recipes) -> None:
    stranger = new_id()
    details = invalid(create(api, s, input_ids=[str(s.cells_input), str(stranger)], steps=[]))
    assert details == {"step_index": None, "reason": "UNKNOWN_INPUT", "input_id": str(stranger)}
    assert api.delete("a.researcher", f"{s.base}/inputs/{s.specs_input}").status_code == 204
    assert invalid(create(api, s))["input_id"] == str(s.specs_input)


def test_input_without_a_table_file(api: WorkspaceApi, world: World, s: Recipes) -> None:
    docs = world.catalog.add_dataset("문서", "PUBLIC")
    world.catalog.add_version(docs, "v1", files=(world.reader.add("README.md", b"# hi"),))
    added = api.post("a.researcher", f"{s.base}/inputs", json={"dataset_id": str(docs.dataset_id)}).json()
    details = invalid(create(api, s, input_ids=[added["input_id"]], steps=[]))
    assert details["reason"] == "INPUT_NOT_TABULAR"


def test_unreadable_input_and_storage_outage(api: WorkspaceApi, world: World, s: Recipes) -> None:
    broken = world.catalog.add_dataset("깨진 표", "PUBLIC")
    tabular_version(world, broken, "v1", "bad.csv", b"a,b\n1,2,3\n")
    added = api.post("a.researcher", f"{s.base}/inputs", json={"dataset_id": str(broken.dataset_id)}).json()
    details = invalid(create(api, s, input_ids=[added["input_id"]], steps=[]))
    assert details["reason"] == "INPUT_UNREADABLE"
    reader.SCHEMAS._entries.clear()
    world.reader.fail_with = StorageUnavailable("down")
    response = create(api, s)
    assert response.status_code == 503 and error_code(response) == "DEPENDENCY_UNAVAILABLE"


@pytest.mark.parametrize(
    "overrides",
    [
        {"name": ""},
        {"name": "   "},
        {"name": "a\x00b"},
        {"input_ids": []},
        {"steps": [{"type": "limit", "n": 0}]},
        {"steps": [{"type": "explode"}]},
        {"steps": [{"type": "limit", "n": 1}] * 51},
    ],
)
def test_request_shape(api: WorkspaceApi, s: Recipes, overrides: dict[str, Any]) -> None:
    response = create(api, s, **overrides)
    assert response.status_code == 422 and error_code(response) == "VALIDATION_FAILED"


def test_duplicate_input_ids_are_rejected(api: WorkspaceApi, s: Recipes) -> None:
    response = create(api, s, input_ids=[str(s.cells_input), str(s.cells_input)], steps=[])
    assert response.status_code == 422 and error_code(response) == "VALIDATION_FAILED"


# ---------------------------------------------------------------- update / delete


def test_update_needs_the_current_version(api: WorkspaceApi, s: Recipes, db: PgUrls) -> None:
    recipe = create(api, s).json()
    url = f"{s.base}/recipes/{recipe['recipe_id']}"
    body = s.body(name="v2 이름", steps=s.steps()[:1])
    saved = api.put("a.researcher", url, json=body, headers={"If-Match": '"1"'})
    assert saved.status_code == 200, saved.text
    assert_matches_response("updateRecipe", 200, saved.json())
    assert (saved.json()["version"], saved.json()["name"]) == (2, "v2 이름")
    stale = api.put("a.researcher", url, json=body, headers={"If-Match": "1"})
    assert stale.status_code == 409 and error_code(stale) == "CONFLICT"
    assert stale.json()["error"]["details"] == {"current_version": 2}
    assert api.put("a.researcher", url, json=body).status_code == 422  # If-Match is required
    assert api.put("a.researcher", url, json=body, headers={"If-Match": "abc"}).status_code == 422

    bad = s.body(steps=[{"type": "sort", "by": ["nope"], "descending": True}])
    assert error_code(api.put("a.researcher", url, json=bad, headers={"If-Match": "2"})) == "RECIPE_INVALID"
    assert api.get("a.researcher", url).json()["version"] == 2

    events = recipe_events(db)
    assert [e["payload"]["recipe_version"] for e in events] == [1, 2]
    versions = sql(db, "SELECT version, name FROM workspace.recipe_versions ORDER BY version")
    assert versions == [{"version": 1, "name": "고온 구간 평균 용량"}, {"version": 2, "name": "v2 이름"}]


def test_update_and_delete_on_an_archived_project(api: WorkspaceApi, world: World, s: Recipes) -> None:
    recipe = create(api, s).json()
    url = f"{s.base}/recipes/{recipe['recipe_id']}"
    world.projects.archived.add(s.project_id)
    assert (
        error_code(api.put("a.researcher", url, json=s.body(), headers={"If-Match": "1"}))
        == "PROJECT_ARCHIVED"
    )
    assert error_code(api.delete("a.researcher", url)) == "PROJECT_ARCHIVED"
    assert api.get("a.viewer", url).status_code == 200


def test_delete_is_soft_and_blocked_by_an_active_run(api: WorkspaceApi, s: Recipes, db: PgUrls) -> None:
    recipe = create(api, s).json()
    url = f"{s.base}/recipes/{recipe['recipe_id']}"
    assert api.post("a.researcher", f"{url}/runs").status_code == 202
    blocked = api.delete("a.researcher", url)
    assert blocked.status_code == 409 and error_code(blocked) == "RUN_NOT_ALLOWED"
    sql(db, "UPDATE workspace.runs SET status = 'FAILED', finished_at = now(), error = 'x'")
    assert api.delete("a.viewer", url).status_code == 403
    assert api.delete("a.researcher", url).status_code == 204
    assert api.get("a.researcher", url).status_code == 404
    assert api.get("a.researcher", f"{s.base}/recipes").json()["items"] == []
    assert api.delete("a.researcher", url).status_code == 404
    assert len(api.get("a.researcher", f"{s.base}/runs").json()["items"]) == 1  # runs keep their history


def test_recipe_threads_resolve_to_the_project(api: WorkspaceApi, s: Recipes) -> None:
    recipe = create(api, s).json()
    body = {
        "scope": "RECIPE",
        "target_id": recipe["recipe_id"],
        "title": "단계 2 확인",
        "body": "평균 대신 중앙값?",
    }
    assert api.post("a.researcher", "/threads", json=body).status_code == 201
    assert api.post("b.researcher", "/threads", json=body).status_code == 404
    api.delete("a.researcher", f"{s.base}/recipes/{recipe['recipe_id']}")
    assert api.post("a.researcher", "/threads", json=body).status_code == 404


# ---------------------------------------------------------------- preview


def preview(api: WorkspaceApi, s: Recipes, recipe_id: str, user: str = "a.researcher", **body: Any) -> Any:
    return api.post(user, f"{s.base}/recipes/{recipe_id}/preview", json=body or None)


def test_preview_of_the_saved_recipe(api: WorkspaceApi, s: Recipes) -> None:
    recipe = create(api, s).json()
    response = preview(api, s, recipe["recipe_id"])
    assert response.status_code == 200, response.text
    assert_matches_response("previewRecipe", 200, response.json())
    assert response.json() == {
        "header": ["cell_id", "capacity_mah_mean", "chemistry"],
        "rows": [["C-01", "2850.5", "NMC"], ["C-02", "2700.0", "LFP"], ["C-03", None, None]],
        "rows_truncated": False,
        "input_rows_read": 7,
        "output_rows": 3,
    }


def test_preview_with_unsaved_steps_and_inputs(api: WorkspaceApi, s: Recipes) -> None:
    recipe = create(api, s).json()
    response = preview(
        api,
        s,
        recipe["recipe_id"],
        input_ids=[str(s.cells_input)],
        steps=[{"type": "filter_rows", "column": "cell_id", "op": "eq", "value": "C-02"}],
    )
    assert response.status_code == 200, response.text
    assert response.json()["header"] == ["cell_id", "temperature_c", "capacity_mah"]
    assert response.json()["rows"] == [["C-02", "50", "2700.0"], ["C-02", "38", "2750.0"]]
    assert response.json()["input_rows_read"] == 5  # the specs input is not read


def test_preview_reads_at_most_10000_rows_and_returns_100(
    api: WorkspaceApi, world: World, s: Recipes
) -> None:
    big = world.catalog.add_dataset("큰 표", "PUBLIC")
    tabular_version(world, big, "v1", "big.csv", b"n\n" + b"".join(b"%d\n" % i for i in range(25_000)))
    added = api.post("a.researcher", f"{s.base}/inputs", json={"dataset_id": str(big.dataset_id)}).json()
    recipe = create(api, s, input_ids=[added["input_id"]], steps=[]).json()
    body = preview(api, s, recipe["recipe_id"]).json()
    assert (body["input_rows_read"], body["output_rows"], body["rows_truncated"]) == (10_000, 10_000, True)
    assert len(body["rows"]) == 100 and body["rows"][0] == ["0"]


def test_preview_failures(api: WorkspaceApi, world: World, s: Recipes) -> None:
    recipe = create(api, s).json()
    cast = [{"type": "cast_type", "column": "cell_id", "to": "int"}]
    failed = preview(api, s, recipe["recipe_id"], input_ids=[str(s.cells_input)], steps=cast)
    assert failed.status_code == 422 and error_code(failed) == "RECIPE_INVALID"
    assert failed.json()["error"]["details"]["reason"] == "CAST_FAILED"
    assert "C-0" not in failed.text  # no data values

    assert preview(api, s, recipe["recipe_id"], user="b.researcher").status_code == 404
    world.grants.revoke(USERS["a.researcher"], s.specs.dataset_id)
    lapsed = preview(api, s, recipe["recipe_id"])
    assert lapsed.status_code == 409 and error_code(lapsed) == "INPUT_ACCESS_LAPSED"
    assert lapsed.json()["error"]["details"] == {"input_ids": [str(s.specs_input)]}

    world.grants.grant(USERS["a.researcher"], s.specs.dataset_id)
    world.reader.fail_with = StorageUnavailable("down")
    down = preview(api, s, recipe["recipe_id"])
    assert down.status_code == 503 and error_code(down) == "DEPENDENCY_UNAVAILABLE"


def test_preview_timeout_is_503(api: WorkspaceApi, s: Recipes, monkeypatch: pytest.MonkeyPatch) -> None:
    recipe = create(api, s).json()
    from api.modules.workspace.service import recipes as service

    monkeypatch.setattr(service, "PREVIEW_TIMEOUT_S", -1.0)
    response = preview(api, s, recipe["recipe_id"])
    assert response.status_code == 503 and error_code(response) == "DEPENDENCY_UNAVAILABLE"
