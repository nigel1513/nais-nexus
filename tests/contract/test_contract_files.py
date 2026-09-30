import json
from collections import Counter
from pathlib import PurePosixPath

import yaml
from jsonschema import Draft202012Validator
from openapi_spec_validator import validate

from api.platform.settings import Settings

CONTRACTS = Settings().contracts_dir


def load_openapi() -> dict:  # type: ignore[type-arg]
    return yaml.safe_load((CONTRACTS / "openapi.yaml").read_text(encoding="utf-8"))


def test_openapi_is_valid() -> None:
    validate(load_openapi())


def test_operation_ids_are_unique() -> None:
    ids = [op["operationId"] for item in load_openapi()["paths"].values() for op in item.values() if isinstance(op, dict) and "operationId" in op]
    assert [i for i, n in Counter(ids).items() if n > 1] == []


def test_event_schema_is_valid_and_matches_the_index() -> None:
    schema = json.loads((CONTRACTS / "events" / "p0_events.schema.json").read_text())
    Draft202012Validator.check_schema(schema)
    index = {e["event_type"] for e in json.loads((CONTRACTS / "events" / "index.json").read_text())["events"]}
    variants = {v["properties"]["event_type"]["const"] for v in schema["oneOf"]}
    assert index == variants


def test_error_codes_are_unique_and_use_known_statuses() -> None:
    codes = json.loads((CONTRACTS / "error_codes.json").read_text())["codes"]
    assert len({c["code"] for c in codes}) == len(codes)
    assert {c["http"] for c in codes} <= {401, 403, 404, 409, 422, 429, 500, 503}


def test_module_ownership_paths_do_not_overlap() -> None:
    ownership = json.loads((CONTRACTS / "module_ownership.json").read_text())
    owned = [(module, PurePosixPath(p)) for module, spec in ownership.items() if isinstance(spec, dict) for p in spec.get("path", [])]
    clashes = [
        (a, str(pa), b, str(pb))
        for i, (a, pa) in enumerate(owned)
        for b, pb in owned[i + 1:]
        if a != b and (pa == pb or pa in pb.parents or pb in pa.parents)
    ]
    assert clashes == []
