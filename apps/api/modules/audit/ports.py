"""Ports M09 consumes (spec §3), per D-038 (W1-D1): the provider-owned public Protocols are the
api.platform.ports keys and are re-exported here; only GrantQueryPort (M04, not in Wave 1) is defined
consumer-side. When nothing is provided under a key, the resolver falls back to the seed-backed fakes
(logged once per port).
"""

import logging
from collections.abc import Callable
from typing import Protocol
from uuid import UUID

from api.modules.audit import fakes
from api.modules.catalog.public import CatalogQueryPort
from api.modules.identity.public import IdentityQueryPort
from api.modules.project.public import ProjectQueryPort
from api.platform import ports

__all__ = ["CatalogQueryPort", "GrantQueryPort", "IdentityQueryPort", "ProjectQueryPort"]

logger = logging.getLogger("nais.audit")


# TODO(Wave 2): replace with api.modules.governance.public
class GrantQueryPort(Protocol):
    def list_active_grant_subjects(self, dataset_id: UUID) -> list[UUID]: ...


_warned: set[str] = set()


def reset_fallback_warnings() -> None:
    _warned.clear()


def _resolve[T](port: type[T], fallback: Callable[[], T]) -> T:
    try:
        return ports.get(port)
    except ports.PortNotProvided:
        name = port.__name__
        if name not in _warned:
            _warned.add(name)
            logger.warning("port not provided; using seed-backed fake", extra={"port": name})
        return fallback()


def identity() -> IdentityQueryPort:
    return _resolve(IdentityQueryPort, fakes.seed_identity)


def projects() -> ProjectQueryPort:
    return _resolve(ProjectQueryPort, fakes.seed_projects)


def catalog() -> CatalogQueryPort:
    return _resolve(CatalogQueryPort, fakes.seed_catalog)


def grants() -> GrantQueryPort:
    return _resolve(GrantQueryPort, fakes.seed_grants)
