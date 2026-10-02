"""The notes HTTP surface is exactly its contract operations (draftNote and searchNotes arrive with Tasks 10/11)."""

from api.modules.notes import MODULE
from api.platform.testing.app import create_test_app
from api.platform.testing.contracts import operation

EXPECTED = {
    "listNotes",
    "getOrCreateTodayNote",
    "getNote",
    "deleteNote",
    "updateNoteBlocks",
    "submitNote",
    "rejectNote",
    "signNote",
    "reviseNote",
    "verifyNote",
    "exportNotes",
    "getNoteSettings",
    "updateNoteSettings",
}


def notes_operations() -> dict[str, tuple[str, str]]:
    app = create_test_app(modules=[MODULE])
    found: dict[str, tuple[str, str]] = {}
    for path, item in app.openapi()["paths"].items():
        for method, op in item.items():
            if "notes" in op.get("tags", []):
                found[op["operationId"]] = (path, method)
    return found


def test_routes_are_exactly_the_contract_operations() -> None:
    found = notes_operations()
    assert set(found) == EXPECTED
    for operation_id, (path, method) in found.items():
        assert (path, method) == (f"/api/v1{operation(operation_id)[0]}", operation(operation_id)[1]), (
            operation_id
        )
