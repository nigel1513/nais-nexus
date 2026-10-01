"""Everything the catalog talks to, in one container registered in api.platform.ports by wire()."""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends
from sqlalchemy.orm import Session

from api.modules.catalog.interfaces import (
    MalwareScannerPort,
    OrganizationLookup,
    SearchIndex,
    VerificationQueue,
)
from api.modules.catalog.objects import StorageRegistry
from api.modules.catalog.settings import CatalogSettings
from api.platform import ports
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode


@dataclass(frozen=True)
class CatalogDeps:
    settings: CatalogSettings
    session_factory: Callable[[], Session]
    storage: StorageRegistry
    organizations: OrganizationLookup
    scanner: MalwareScannerPort
    verification: VerificationQueue
    search: SearchIndex


def get_deps() -> CatalogDeps:
    try:
        return ports.get(CatalogDeps)
    except ports.PortNotProvided as exc:
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Catalog module is not wired.") from exc


CatalogDepsDep = Annotated[CatalogDeps, Depends(get_deps)]
