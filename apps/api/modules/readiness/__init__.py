"""M05 AI-Ready Pipeline (readiness): deterministic validation of PUBLISHED dataset versions."""

from pathlib import Path

from api.modules.readiness.jobs import register_worker
from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="readiness",
    db_schema="readiness",
    migrations_dir=Path(__file__).parent / "migrations",
    register_worker=register_worker,
)
