"""M13 Project Workspace & Data Hub (spec docs/superpowers/specs/2026-10-02-data-hub-workspace-notes-design.md §5)."""

from pathlib import Path

from api.modules.workspace import handlers  # noqa: F401  (registers the @subscribe event consumers)
from api.modules.workspace.jobs import QUEUE, register_worker
from api.modules.workspace.router import router
from api.modules.workspace.settings import get_workspace_settings
from api.modules.workspace.wiring import wire
from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="workspace",
    db_schema="workspace",
    router=router,
    migrations_dir=Path(__file__).parent / "migrations",
    wire=wire,
    register_worker=register_worker,
    dedicated_queues={QUEUE: get_workspace_settings().workspace_worker_concurrency},
)
