"""M02 Project Collaboration (NAIS_PRD/modules/M02_project_collaboration.md)."""

from pathlib import Path

from api.modules.project.query import wire
from api.modules.project.router import router
from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="project",
    db_schema="project",
    router=router,
    migrations_dir=Path(__file__).parent / "migrations",
    wire=wire,
)
