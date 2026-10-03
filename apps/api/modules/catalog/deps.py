"""Everything the catalog talks to, in one container registered in api.platform.ports by wire()."""

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Annotated

from fastapi import Depends
from sqlalchemy.orm import Session

from api.modules.catalog.adapters.grants import NoGrants
from api.modules.catalog.interfaces import (
    MalwareScannerPort,
    OrganizationLookup,
    PreviewGrantLookup,
    SearchIndex,
    VerificationQueue,
)
from api.modules.catalog.objects import StorageRegistry
from api.modules.catalog.settings import CatalogSettings
from api.platform import ports
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.llm import EmbeddingClient


@dataclass(frozen=True)
class CatalogDeps:
    settings: CatalogSettings
    session_factory: Callable[[], Session]
    storage: StorageRegistry
    organizations: OrganizationLookup
    scanner: MalwareScannerPort
    verification: VerificationQueue
    search: SearchIndex
    grants: PreviewGrantLookup = field(default_factory=NoGrants)
    # Semantic half of the hybrid search (bge-m3). None (NAIS_LLM_ENABLED off, no NAIS_EMBED_BASE_URL): lexical only.
    embedder: EmbeddingClient | None = None  # worker: documents
    query_embedder: EmbeddingClient | None = None  # request path: the search text, short timeout


def get_deps() -> CatalogDeps:
    try:
        return ports.get(CatalogDeps)
    except ports.PortNotProvided as exc:
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Catalog module is not wired.") from exc


CatalogDepsDep = Annotated[CatalogDeps, Depends(get_deps)]
