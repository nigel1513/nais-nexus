"""M14 Research notes (연구노트; spec docs/superpowers/specs/2026-10-02-data-hub-workspace-notes-design.md §6)."""

from pathlib import Path

from api.modules.notes.router import router
from api.modules.notes.wiring import wire
from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="notes",
    db_schema="notes",
    router=router,
    migrations_dir=Path(__file__).parent / "migrations",
    wire=wire,
)
