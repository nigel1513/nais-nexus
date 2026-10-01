"""M03 Data Catalog & Versioning. Spec: NAIS_PRD/modules/M03_data_catalog.md."""

from pathlib import Path

from api.modules.catalog import (  # noqa: F401  (register @subscribe handlers and the verify actor)
    handlers,
    jobs,
)
from api.modules.catalog.jobs import register_worker
from api.modules.catalog.router import router
from api.modules.catalog.wiring import wire
from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="catalog",
    db_schema="catalog",
    router=router,
    migrations_dir=Path(__file__).parent / "migrations",
    wire=wire,
    register_worker=register_worker,
)
