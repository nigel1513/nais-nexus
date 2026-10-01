"""IdentityQueryPort (M01 §8, api.modules.identity.public) as M02 consumes it, and runtime resolution."""

import logging
from functools import lru_cache

from api.modules import identity as identity_package
from api.modules.identity.public import IdentityPublicProfile, IdentityQueryPort, OrganizationSummary
from api.modules.project.identity_fake import FakeIdentityQueryPort
from api.platform import ports
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.modules import ModuleSpec

logger = logging.getLogger("nais.project")

IDENTITY_PACKAGE = "api.modules.identity"

__all__ = [
    "IDENTITY_PACKAGE",
    "IdentityPublicProfile",
    "IdentityQueryPort",
    "OrganizationSummary",
    "get_identity_port",
    "identity_module_installed",
]


def identity_module_installed() -> bool:
    """True when api.modules.identity is a real module package (defines MODULE = ModuleSpec)."""
    return isinstance(getattr(identity_package, "MODULE", None), ModuleSpec)


@lru_cache(maxsize=1)
def _seed_fallback() -> IdentityQueryPort:
    logger.warning("identity module not installed; project uses the seed-user FakeIdentityQueryPort (Wave 1)")
    return FakeIdentityQueryPort.with_seed_users()


def get_identity_port() -> IdentityQueryPort:
    """Resolve the identity read port. Also used as a FastAPI dependency."""
    try:
        return ports.get(IdentityQueryPort)
    except ports.PortNotProvided:
        pass
    if not identity_module_installed():
        return _seed_fallback()
    raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Identity directory is not available.")
