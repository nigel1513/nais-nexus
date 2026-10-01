"""M01 Identity & Organization: NAIS users, organizations and memberships (Keycloak authenticates, D-019)."""

from pathlib import Path

from api.modules.identity.jobs import register_worker
from api.modules.identity.keycloak_admin import HttpKeycloakAdmin, KeycloakAdminPort
from api.modules.identity.public import IdentityQueryPort
from api.modules.identity.query import SqlIdentityQuery
from api.modules.identity.resolver import IdentityPrincipalResolver, SessionFactory
from api.modules.identity.router import router
from api.modules.identity.seed import seed
from api.modules.identity.settings import get_identity_settings
from api.platform import ports
from api.platform.auth import PrincipalResolver
from api.platform.db import session_scope
from api.platform.modules import ModuleSpec


def wire_ports(sessions: SessionFactory = session_scope) -> None:
    """Provide M01's ports. Production uses DATABASE_URL; tests pass a factory bound to their database."""
    ports.provide(PrincipalResolver, IdentityPrincipalResolver(sessions))
    ports.provide(IdentityQueryPort, SqlIdentityQuery(sessions))
    settings = get_identity_settings()
    ports.provide(
        KeycloakAdminPort,
        HttpKeycloakAdmin(
            settings.keycloak_admin_url,
            settings.keycloak_realm,
            settings.keycloak_admin_user,
            settings.keycloak_admin_password,
        ),
    )


def wire() -> None:
    wire_ports()


MODULE = ModuleSpec(
    name="identity",
    db_schema="identity",
    router=router,
    migrations_dir=Path(__file__).parent / "migrations",
    wire=wire,
    register_worker=register_worker,
    seed=seed,
)
