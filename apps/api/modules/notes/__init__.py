"""M14 Research notes (연구노트; spec docs/superpowers/specs/2026-10-02-data-hub-workspace-notes-design.md §6)."""

from pathlib import Path

from api.modules.notes import handlers  # noqa: F401  (registers the @subscribe evidence consumers)
from api.modules.notes.jobs import QUEUE, register_worker
from api.modules.notes.router import router
from api.modules.notes.wiring import wire
from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="notes",
    db_schema="notes",
    router=router,
    migrations_dir=Path(__file__).parent / "migrations",
    wire=wire,
    register_worker=register_worker,
    dedicated_queues={QUEUE: 1},  # one draft at a time: the GPU is shared with another platform
)
