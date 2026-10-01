"""M05 AI-Ready Pipeline (readiness): deterministic validation of PUBLISHED dataset versions."""

from pathlib import Path

from api.modules.readiness import handlers  # noqa: F401  - registers @subscribe handlers at import
from api.modules.readiness.jobs import register_worker
from api.modules.readiness.query import wire
from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="readiness",
    db_schema="readiness",
    migrations_dir=Path(__file__).parent / "migrations",
    wire=wire,
    register_worker=register_worker,
)
