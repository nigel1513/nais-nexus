"""_schema.json (09 §1.2 subset) → per-file column hints for the Data Explorer. Tolerant: anything malformed is
ignored (readiness reports schema problems; the explorer only decorates)."""

import json
from typing import Any

from api.modules.catalog.previews.profile import FieldHint

TYPES = {"string", "integer", "number", "boolean", "date", "datetime"}


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def parse_schema_hints(raw: bytes) -> dict[str, dict[str, FieldHint]]:
    try:
        doc = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
        return {}
    out: dict[str, dict[str, FieldHint]] = {}
    resources = doc.get("resources") if isinstance(doc, dict) else None
    for resource in resources if isinstance(resources, list) else []:
        if not isinstance(resource, dict) or not isinstance(resource.get("path"), str):
            continue
        schema = resource.get("schema")
        fields = schema.get("fields") if isinstance(schema, dict) else None
        hints: dict[str, FieldHint] = {}
        for f in fields if isinstance(fields, list) else []:
            if isinstance(f, dict) and isinstance(f.get("name"), str):
                concept = _text(f.get("x-nais-concept"))
                ftype = f.get("type")
                hints[f["name"]] = FieldHint(
                    ftype if isinstance(ftype, str) and ftype in TYPES else None,
                    _text(f.get("unit")),
                    _text(f.get("description")),
                    concept if concept and concept.startswith(("http://", "https://")) else None,
                )
        out[resource["path"]] = hints
    return out
