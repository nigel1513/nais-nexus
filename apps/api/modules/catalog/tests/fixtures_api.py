from dataclasses import replace

import pytest

from api.modules.catalog.adapters.identity import FakeIdentityPort
from api.modules.catalog.adapters.malware import NoopScanner
from api.modules.catalog.deps import CatalogDeps
from api.modules.catalog.search.opensearch import OpenSearchIndex
from api.modules.catalog.settings import CatalogSettings
from api.modules.catalog.testing import RecordingSearchIndex, RecordingVerificationQueue, memory_registry
from api.modules.catalog.tests.support_api import CatalogApi, make_api
from api.platform.db import session_factory
from api.platform.testing.fixtures import PgUrls


@pytest.fixture
def deps(db: PgUrls) -> CatalogDeps:
    return CatalogDeps(
        settings=CatalogSettings(),
        session_factory=session_factory(db.app),
        storage=memory_registry(),
        organizations=FakeIdentityPort(),
        scanner=NoopScanner(),
        verification=RecordingVerificationQueue(),
        search=RecordingSearchIndex(),
    )


@pytest.fixture
def api(db: PgUrls, deps: CatalogDeps) -> CatalogApi:
    return make_api(db, deps)


@pytest.fixture
def search_api(api: CatalogApi, search_index: OpenSearchIndex) -> CatalogApi:
    api.use(replace(api.deps, search=search_index))
    return api
