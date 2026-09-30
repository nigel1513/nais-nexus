"""Run Alembic per target (platform first, then each module) with a version table in the target's schema."""

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from alembic import command
from alembic.config import Config

from api.platform.modules import ModuleSpec

MIGRATIONS_ENV_DIR = Path(__file__).parent / "migrations"


@dataclass(frozen=True)
class MigrationTarget:
    name: str
    schema: str
    versions_dir: Path


PLATFORM_TARGET = MigrationTarget("platform", "platform", MIGRATIONS_ENV_DIR / "versions")


def migration_targets(modules: Sequence[ModuleSpec]) -> list[MigrationTarget]:
    targets = [PLATFORM_TARGET]
    for spec in modules:
        if spec.migrations_dir is None:
            continue
        if spec.db_schema is None:
            raise ValueError(f"module {spec.name!r} has migrations_dir but no db_schema")
        targets.append(MigrationTarget(spec.name, spec.db_schema, spec.migrations_dir))
    return targets


def alembic_config(url: str, target: MigrationTarget) -> Config:
    config = Config()
    config.set_main_option("script_location", str(MIGRATIONS_ENV_DIR))
    config.set_main_option("path_separator", "os")
    config.set_main_option("version_locations", str(target.versions_dir))
    config.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    config.attributes["version_table_schema"] = target.schema
    return config


def upgrade_all(url: str, modules: Sequence[ModuleSpec], *, sql: bool = False) -> list[str]:
    applied: list[str] = []
    for target in migration_targets(modules):
        command.upgrade(alembic_config(url, target), "head", sql=sql)
        applied.append(target.name)
    return applied


def new_revision(url: str, target: MigrationTarget, message: str) -> Path:
    target.versions_dir.mkdir(parents=True, exist_ok=True)
    script = command.revision(alembic_config(url, target), message=message, version_path=str(target.versions_dir))
    if script is None or isinstance(script, list):
        raise RuntimeError("alembic did not create exactly one revision")
    return Path(script.path)
