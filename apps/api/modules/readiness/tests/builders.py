"""Evaluation contexts over in-memory files, for validator unit tests."""

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

from api.modules.readiness.engine.context import EvaluationContext
from api.modules.readiness.fakes import FixtureCatalog
from api.modules.readiness.profile_registry import PROFILES
from api.modules.readiness.tests.helpers import ORG_B, clean_snapshot, fixture_files


def make_ctx(
    files: dict[str, Path | bytes] | dict[str, bytes] | None = None,
    snapshot: dict[str, Any] | None = None,
    catalog: FixtureCatalog | None = None,
    **params: Any,
) -> EvaluationContext:
    """A TABULAR_ML_BASIC context (parameters overridable) over `files` (default: clean_tabular)."""
    catalog = catalog or FixtureCatalog()
    view = catalog.add_version(
        dict(fixture_files() if files is None else files),
        clean_snapshot() if snapshot is None else snapshot,
        owner_organization_id=ORG_B,
    )
    assert view.metadata_snapshot is not None
    return EvaluationContext(
        snapshot=view.metadata_snapshot,
        files=view.files,
        manifest_sha256=view.manifest_sha256,
        reader=catalog,
        params=replace(PROFILES["TABULAR_ML_BASIC"].params, **params),
    )


def schema_doc(path: str, fields: list[dict[str, Any]], **schema: Any) -> dict[str, Any]:
    return {"resources": [{"path": path, "schema": {"fields": fields, **schema}}]}


def with_schema(files: dict[str, bytes], doc: dict[str, Any]) -> dict[str, bytes]:
    return {**files, "_schema.json": json.dumps(doc).encode("utf-8")}
