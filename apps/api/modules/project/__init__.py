"""M02 Project Collaboration (NAIS_PRD/modules/M02_project_collaboration.md)."""

from pathlib import Path

from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="project",
    db_schema="project",
    migrations_dir=Path(__file__).parent / "migrations",
)
