"""M03 Data Catalog & Versioning. Spec: NAIS_PRD/modules/M03_data_catalog.md."""

from pathlib import Path

from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="catalog",
    db_schema="catalog",
    migrations_dir=Path(__file__).parent / "migrations",
)
