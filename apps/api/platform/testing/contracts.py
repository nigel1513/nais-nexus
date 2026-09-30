"""Contract assertions for module tests: responses vs openapi.yaml, events vs p0_events.schema.json."""

from functools import lru_cache
from typing import Any

import yaml
from jsonschema import Draft202012Validator

from api.platform.events import EventSchemaError, validate_envelope
from api.platform.settings import get_settings

_METHODS = ("get", "post", "put", "patch", "delete")


@lru_cache(maxsize=1)
def _spec() -> dict[str, Any]:
    spec: dict[str, Any] = yaml.safe_load((get_settings().contracts_dir / "openapi.yaml").read_text(encoding="utf-8"))
    return spec


def _escape(part: str) -> str:
    return part.replace("~", "~0").replace("/", "~1")


def _pointer(*parts: str) -> str:
    return "#/" + "/".join(_escape(p) for p in parts)


def operation(operation_id: str) -> tuple[str, str]:
    for path, item in _spec()["paths"].items():
        for method in _METHODS:
            if item.get(method, {}).get("operationId") == operation_id:
                return path, method
    raise AssertionError(f"unknown operationId {operation_id!r}")


def assert_matches_response(operation_id: str, status_code: int, body: Any) -> None:
    path, method = operation(operation_id)
    responses = _spec()["paths"][path][method]["responses"]
    response = responses.get(str(status_code))
    if response is None:
        raise AssertionError(f"{operation_id} declares no {status_code} response in openapi.yaml")
    base: tuple[str, ...] = ("paths", path, method, "responses", str(status_code))
    if "$ref" in response:
        ref_parts = response["$ref"].removeprefix("#/").split("/")
        base = tuple(ref_parts)
        response = _spec()
        for part in ref_parts:
            response = response[part]
    if "content" not in response:
        if body not in (None, b"", ""):
            raise AssertionError(f"{operation_id} {status_code} declares no body but got {body!r}")
        return
    root = {**_spec(), "$ref": _pointer(*base, "content", "application/json", "schema")}
    errors = sorted(Draft202012Validator(root).iter_errors(body), key=lambda e: list(e.absolute_path))
    if errors:
        details = "\n".join(f"  {'/'.join(map(str, e.absolute_path)) or '(root)'}: {e.message}" for e in errors)
        raise AssertionError(f"{operation_id} {status_code} response violates openapi.yaml:\n{details}")


def assert_valid_event(envelope: dict[str, Any]) -> None:
    try:
        validate_envelope(envelope)
    except EventSchemaError as exc:
        raise AssertionError(str(exc)) from exc
