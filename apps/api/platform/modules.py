"""Module plug-in contract (D-036). Each module defines MODULE = ModuleSpec(...) in its __init__.py."""

import importlib
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import APIRouter

DEFAULT_MODULE_ORDER: tuple[str, ...] = (
    "identity",
    "project",
    "catalog",
    "readiness",
    "governance",
    "audit",
    "marketplace",
    "compute",
    "knowledge",
    "autonomy",
)


@dataclass(frozen=True)
class ModuleSpec:
    """What a module plugs into the platform (D-036).

    Event handlers register with @subscribe at import time, so the module package __init__ MUST import its handler
    modules; otherwise its events are relayed with no handler and silently marked dispatched. The worker logs the
    subscription table (event_type -> handlers) at start. Endpoints get a DB session via api.platform.db.SessionDep.
    """

    name: str
    db_schema: str | None = None
    router: APIRouter | None = None
    migrations_dir: Path | None = None
    wire: Callable[[], None] | None = None
    register_worker: Callable[[Any, Any], None] | None = None  # (broker, scheduler)
    seed: Callable[[Any], None] | None = None  # (session)


def discover_modules(names: Iterable[str] = DEFAULT_MODULE_ORDER) -> list[ModuleSpec]:
    specs: list[ModuleSpec] = []
    for name in names:
        qualified = f"api.modules.{name}"
        try:
            module = importlib.import_module(qualified)
        except ModuleNotFoundError as exc:
            if exc.name == qualified:
                continue
            raise
        if getattr(module, "__file__", None) is None:
            continue  # empty namespace directory, module not started yet
        spec = getattr(module, "MODULE", None)
        if not isinstance(spec, ModuleSpec):
            raise TypeError(f"{qualified} must define MODULE = ModuleSpec(...)")
        specs.append(spec)
    return specs
