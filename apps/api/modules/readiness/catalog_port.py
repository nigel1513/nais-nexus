"""M03 public types readiness consumes (W1-D1 / D-038: M03 owns them in api.modules.catalog.public).

This file only re-exports them so the rest of readiness keeps one import path. The Protocol classes ARE the
`api.platform.ports` registry keys M03 provides in its wiring; tests provide `fakes.FixtureCatalog` under the
same keys. Nothing else in readiness may import catalog code.
"""

from api.modules.catalog.public import (
    CatalogQueryPort,
    CatalogReadPort,
    FileRef,
    ObjectMissing,
    StorageUnavailable,
    VersionView,
)

__all__ = [
    "CatalogQueryPort",
    "CatalogReadPort",
    "FileRef",
    "ObjectMissing",
    "StorageUnavailable",
    "VersionView",
]
