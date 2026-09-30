"""Seed orchestrator (10_SEED_DATA.md §1). Each module's seed() must be idempotent (fixed UUIDs)."""

from collections.abc import Sequence

from api.platform.db import session_scope
from api.platform.modules import ModuleSpec


def run_seed(modules: Sequence[ModuleSpec], *, url: str | None = None) -> list[str]:
    seeded: list[str] = []
    for spec in modules:
        if spec.seed is None:
            continue
        with session_scope(url) as session:
            spec.seed(session)
        seeded.append(spec.name)
    return seeded
