"""M01 Identity & Organization: NAIS users, organizations and memberships (Keycloak authenticates, D-019)."""

from pathlib import Path

from api.platform.modules import ModuleSpec

MODULE = ModuleSpec(
    name="identity",
    db_schema="identity",
    migrations_dir=Path(__file__).parent / "migrations",
)
