"""M03-AT-18: the catalog HTTP surface is exactly its contract operations and never hands out download URLs."""

from pathlib import Path
from typing import Any

import yaml

import api.modules.catalog as catalog_pkg
from api.modules.catalog import MODULE
from api.platform.settings import get_settings
from api.platform.testing.app import create_test_app
from api.platform.testing.contracts import operation

EXPECTED = {
    "searchDatasets",
    "createDataset",
    "getDataset",
    "updateDataset",
    "getDatasetPolicy",
    "listDatasetVersions",
    "createDatasetVersion",
    "getDatasetVersion",
    "createUploadSession",
    "getUploadSession",
    "completeUploadSession",
    "deleteDraftFile",
    "publishDatasetVersion",
}


def catalog_operations() -> dict[str, tuple[str, str]]:
    """operationId -> (path, method) of every route tagged "catalog", read from the app's generated OpenAPI
    (FastAPI mounts included routers lazily, so app.routes does not list them)."""
    app = create_test_app(modules=[MODULE])
    found: dict[str, tuple[str, str]] = {}
    for path, item in app.openapi()["paths"].items():
        for method, op in item.items():
            if "catalog" in op.get("tags", []):
                found[op["operationId"]] = (path, method)
    return found


def test_routes_are_exactly_the_contract_operations() -> None:
    found = catalog_operations()
    assert set(found) == EXPECTED
    for operation_id, (path, method) in found.items():
        assert (path, method) == (f"/api/v1{operation(operation_id)[0]}", operation(operation_id)[1]), (
            operation_id
        )


def _url_contexts(spec: dict[str, Any], node: Any, context: str, seen: set[str], found: set[str]) -> None:
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
            name = ref.rsplit("/", 1)[-1]
            if name not in seen:
                seen.add(name)
                _url_contexts(spec, spec["components"]["schemas"][name], name, seen, found)
            return
        if "url" in node.get("properties", {}):
            found.add(context)
        for value in node.values():
            _url_contexts(spec, value, context, seen, found)
    elif isinstance(node, list):
        for value in node:
            _url_contexts(spec, value, context, seen, found)


def test_no_catalog_response_carries_a_download_url() -> None:
    spec = yaml.safe_load((get_settings().contracts_dir / "openapi.yaml").read_text(encoding="utf-8"))
    for operation_id in EXPECTED:
        path, method = operation(operation_id)
        responses = spec["paths"][path][method]["responses"]
        found: set[str] = set()
        for status, response in responses.items():
            if str(status).startswith("2"):
                _url_contexts(spec, response, operation_id, set(), found)
        # the only URLs a catalog operation returns are presigned *upload* URLs inside UploadSession
        assert found <= {"UploadSession"}, (operation_id, found)


def test_only_the_storage_port_presigns_downloads() -> None:
    package = Path(catalog_pkg.__file__).parent
    allowed = {"objects.py", "testing.py", "public.py", "public_impl.py"}
    offenders = [
        str(path.relative_to(package))
        for path in package.rglob("*.py")
        if "tests" not in path.parts
        and path.name not in allowed
        and "presign_get(" in path.read_text(encoding="utf-8")
    ]
    assert offenders == []
