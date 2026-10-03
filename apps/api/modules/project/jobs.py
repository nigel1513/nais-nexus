"""Worker jobs of the project module: project.index_sync keeps the public project index equal to the database."""

from typing import TYPE_CHECKING

from api.modules.project.identity import get_identity_port
from api.modules.project.query import get_project_search
from api.modules.project.search import SYNC_INTERVAL_S, reconcile_job
from api.platform.db import session_factory

if TYPE_CHECKING:
    import dramatiq

    from api.platform.scheduler import Scheduler


def register_worker(broker: "dramatiq.Broker", scheduler: "Scheduler") -> None:
    search = get_project_search()
    if search is None:
        return
    scheduler.every(
        SYNC_INTERVAL_S,
        "project.index_sync",
        reconcile_job(search, session_factory(), get_identity_port),
        run_immediately=True,
    )
