"""The workspace HTTP surface is exactly its contract operations (grows with each task of the plan)."""

from api.modules.workspace import MODULE
from api.platform.testing.app import create_test_app
from api.platform.testing.contracts import operation

EXPECTED = {
    "listProjectInputs",
    "addProjectInput",
    "updateProjectInput",
    "removeProjectInput",
}


def workspace_operations() -> dict[str, tuple[str, str]]:
    """operationId -> (path, method) of every route tagged "workspace", read from the app's generated OpenAPI."""
    app = create_test_app(modules=[MODULE])
    found: dict[str, tuple[str, str]] = {}
    for path, item in app.openapi()["paths"].items():
        for method, op in item.items():
            if "workspace" in op.get("tags", []):
                found[op["operationId"]] = (path, method)
    return found


def test_routes_are_exactly_the_contract_operations() -> None:
    found = workspace_operations()
    assert set(found) == EXPECTED
    for operation_id, (path, method) in found.items():
        assert (path, method) == (f"/api/v1{operation(operation_id)[0]}", operation(operation_id)[1]), (
            operation_id
        )
