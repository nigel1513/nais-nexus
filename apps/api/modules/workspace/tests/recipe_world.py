"""Shared setup for recipe and run tests: a project with two pinned CSV inputs (PUBLIC cells, CONTROLLED specs)."""

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from api.modules.catalog.public import DatasetPolicyView, VersionView
from api.modules.workspace.tests.conftest import WorkspaceApi, World
from api.modules.workspace.tests.fakes import ORG_B, USERS
from api.platform.ids import new_id

CELLS_CSV = (
    b"cell_id,temperature_c,capacity_mah\n"
    b"C-01,25,2900\n"
    b"C-01,45,2850.5\n"
    b"C-02,50,2700\n"
    b"C-02,38,2750\n"
    b"C-03,41,\n"
)
SPECS_CSV = b"cell_id,chemistry\nC-01,NMC\nC-02,LFP\n"


@dataclass
class Recipes:
    project_id: UUID
    cells: DatasetPolicyView
    cells_v1: VersionView
    specs: DatasetPolicyView
    specs_v1: VersionView
    cells_input: UUID
    specs_input: UUID

    @property
    def base(self) -> str:
        return f"/projects/{self.project_id}"

    def steps(self) -> list[dict[str, Any]]:
        return [
            {"type": "filter_rows", "column": "temperature_c", "op": "ge", "value": 40},
            {
                "type": "aggregate",
                "group_by": ["cell_id"],
                "metrics": [{"column": "capacity_mah", "fn": "mean"}],
            },
            {"type": "join", "right_input_id": str(self.specs_input), "on": ["cell_id"], "how": "left"},
            {"type": "sort", "by": ["cell_id"], "descending": False},
        ]

    def body(self, **overrides: Any) -> dict[str, Any]:
        return {
            "name": "고온 구간 평균 용량",
            "input_ids": [str(self.cells_input), str(self.specs_input)],
            "steps": self.steps(),
        } | overrides


def tabular_version(
    world: World, dataset: DatasetPolicyView, label: str, path: str, data: bytes
) -> VersionView:
    return world.catalog.add_version(dataset, label, files=(world.reader.add(path, data),))


def build(api: WorkspaceApi, world: World) -> Recipes:
    project_id = new_id()
    world.projects.add(project_id, USERS["a.owner"], "PROJECT_OWNER")  # lead organization ORG_A (inst-a)
    world.projects.add(project_id, USERS["a.researcher"], "RESEARCHER")
    world.projects.add(project_id, USERS["a.viewer"], "VIEWER")
    cells = world.catalog.add_dataset("셀 측정", "PUBLIC", owner=ORG_B)
    cells_v1 = tabular_version(world, cells, "v1", "data/cells.csv", CELLS_CSV)
    specs = world.catalog.add_dataset("셀 사양", "CONTROLLED", owner=ORG_B)
    specs_v1 = tabular_version(world, specs, "v1", "specs.csv", SPECS_CSV)
    world.grants.grant(USERS["a.researcher"], specs.dataset_id)
    ids = []
    for dataset in (cells, specs):
        response = api.post(
            "a.researcher", f"/projects/{project_id}/inputs", json={"dataset_id": str(dataset.dataset_id)}
        )
        assert response.status_code == 201, response.text
        ids.append(UUID(response.json()["input_id"]))
    return Recipes(project_id, cells, cells_v1, specs, specs_v1, ids[0], ids[1])


def create(api: WorkspaceApi, s: Recipes, user: str = "a.researcher", **overrides: Any) -> Any:
    return api.post(user, f"{s.base}/recipes", json=s.body(**overrides))


def error_code(response: Any) -> str:
    return str(response.json()["error"]["code"])
