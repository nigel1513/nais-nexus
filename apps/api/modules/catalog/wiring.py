"""ModuleSpec.wire(): build the default CatalogDeps and register the catalog's ports."""

import importlib
import logging
import os

from api.modules.catalog.adapters.identity import FakeIdentityPort, IdentityQueryAdapter
from api.modules.catalog.adapters.malware import build_scanner
from api.modules.catalog.adapters.queue import DramatiqVerificationQueue
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.interfaces import OrganizationLookup
from api.modules.catalog.objects import StorageRegistry
from api.modules.catalog.public import CatalogPublishPort, CatalogQueryPort, CatalogReadPort, StoragePort
from api.modules.catalog.public_impl import CatalogQueryService, CatalogReader, CatalogStorageService
from api.modules.catalog.search.opensearch import OpenSearchIndex
from api.modules.catalog.service.from_output import CatalogOutputPublisher
from api.modules.catalog.settings import CatalogSettings, get_catalog_settings
from api.platform import ports
from api.platform.db import session_factory
from api.platform.llm import get_embedding_client

logger = logging.getLogger("nais.catalog")


def default_organization_lookup() -> OrganizationLookup:
    """Identity installed (Wave 1: always, M01 is built first) -> IdentityQueryAdapter (503 while unwired);
    identity package absent -> FakeIdentityPort with a warning (original mock-first rule)."""
    try:
        importlib.import_module("api.modules.identity.public")
    except ModuleNotFoundError as exc:
        if exc.name not in {"api.modules.identity", "api.modules.identity.public"}:
            raise
        logger.warning("identity module not installed; catalog uses FakeIdentityPort (Wave 1 mock-first)")
        return FakeIdentityPort()
    return IdentityQueryAdapter()


def build_default_deps(settings: CatalogSettings | None = None) -> CatalogDeps:
    settings = settings or get_catalog_settings()
    return CatalogDeps(
        settings=settings,
        session_factory=session_factory(),
        storage=StorageRegistry(os.environ, settings.nais_public_base_url, settings.storage_org_code_list),
        organizations=default_organization_lookup(),
        scanner=build_scanner(settings.malware_scanner),
        verification=DramatiqVerificationQueue(),
        search=OpenSearchIndex(
            settings.opensearch_url,
            settings.catalog_index_alias,
            timeout=settings.catalog_opensearch_timeout_seconds,
        ),
        demo_search=OpenSearchIndex(
            settings.opensearch_url,
            settings.catalog_demo_index_alias,
            timeout=settings.catalog_opensearch_timeout_seconds,
        ),
        embedder=get_embedding_client(),
        query_embedder=get_embedding_client(settings.catalog_embed_query_timeout_seconds),
    )


def install(deps: CatalogDeps) -> None:
    """Register the deps container and the public ports (M04 uses CatalogQueryPort + StoragePort,
    M05 and M13 use CatalogQueryPort + CatalogReadPort; the registry cannot restrict consumers, see README)."""
    ports.provide(CatalogDeps, deps)
    ports.provide(CatalogQueryPort, CatalogQueryService(deps))
    ports.provide(StoragePort, CatalogStorageService(deps))
    ports.provide(CatalogReadPort, CatalogReader(deps))
    ports.provide(CatalogPublishPort, CatalogOutputPublisher(deps))  # M13 output publication


def wire() -> None:
    install(build_default_deps())
