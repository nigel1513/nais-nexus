import base64
from collections import deque
from typing import Annotated

import pytest
from fastapi import APIRouter, Depends
from fastapi.testclient import TestClient

from api.platform.modules import ModuleSpec
from api.platform.pagination import PageParams, build_page, decode_cursor, encode_cursor, page_params
from api.platform.testing.app import create_test_app


def make_client() -> TestClient:
    router = APIRouter()

    @router.get("/things")
    def things(params: Annotated[PageParams, Depends(page_params)]) -> dict[str, object]:
        return {"cursor": params.cursor, "limit": params.limit}

    return TestClient(create_test_app(modules=[ModuleSpec(name="things", router=router)]))


def test_cursor_round_trip() -> None:
    assert decode_cursor(encode_cursor(["2026-09-30T00:00:00Z", "abc"])) == ["2026-09-30T00:00:00Z", "abc"]


def test_default_limit_and_valid_cursor() -> None:
    body = make_client().get("/api/v1/things", params={"cursor": encode_cursor([1, "x"])}).json()
    assert body == {"cursor": [1, "x"], "limit": 20}


def test_garbage_cursor_is_422() -> None:
    for garbage in ("%%%", "bm90LWpzb24", "한글"):
        response = make_client().get("/api/v1/things", params={"cursor": garbage})
        assert response.status_code == 422
        assert response.json()["error"]["details"]["fields"][0]["field"] == "cursor"


def test_non_list_cursor_is_422() -> None:
    for raw in (b'{"a":1}', b"[]"):
        cursor = base64.urlsafe_b64encode(raw).decode().rstrip("=")
        response = make_client().get("/api/v1/things", params={"cursor": cursor})
        assert response.status_code == 422


class FakeRow(tuple):  # type: ignore[type-arg]  # like sqlalchemy.engine.Row: a tuple subclass
    pass


def test_encode_cursor_accepts_tuples_and_row_like_sequences() -> None:
    assert decode_cursor(encode_cursor(("2026-09-30", 7))) == ["2026-09-30", 7]
    assert decode_cursor(encode_cursor(FakeRow(("2026-09-30", 7)))) == ["2026-09-30", 7]
    assert decode_cursor(encode_cursor(deque(["a", 1]))) == ["a", 1]


def test_encode_cursor_rejects_mappings_and_strings() -> None:
    for bad in ({"a": 1}, "abc", b"abc"):
        with pytest.raises(TypeError):
            encode_cursor(bad)  # type: ignore[arg-type]


def test_oversized_cursor_and_bad_limits_are_422() -> None:
    client = make_client()
    assert client.get("/api/v1/things", params={"cursor": "a" * 513}).status_code == 422
    assert client.get("/api/v1/things", params={"limit": 0}).status_code == 422
    assert client.get("/api/v1/things", params={"limit": 101}).status_code == 422


def test_build_page_sets_has_more_and_next_cursor_from_last_item() -> None:
    page = build_page([1, 2, 3], limit=2, key=lambda n: [n])
    assert page.items == [1, 2]
    assert page.page.has_more is True
    assert decode_cursor(page.page.next_cursor or "") == [2]


def test_build_page_last_page_has_no_cursor() -> None:
    page = build_page([1, 2], limit=2, key=lambda n: [n])
    assert page.page.has_more is False
    assert page.page.next_cursor is None
