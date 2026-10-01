from typing import Any, cast
from uuid import UUID

import pytest

from api.modules.catalog import MODULE, wiring
from api.modules.catalog.adapters.identity import FakeIdentityPort, IdentityQueryAdapter
from api.modules.catalog.adapters.malware import NoopScanner, build_scanner
from api.modules.catalog.adapters.queue import DramatiqVerificationQueue
from api.modules.catalog.deps import CatalogDeps, get_deps
from api.modules.catalog.interfaces import OrganizationSummary
from api.modules.catalog.objects import StorageRegistry
from api.modules.catalog.search.opensearch import OpenSearchIndex
from api.modules.catalog.tests.support import ORG_A, ORG_B, ORG_NAIS
from api.modules.identity import public as identity_public
from api.modules.identity.public import IdentityQueryPort
from api.platform import ports
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.testing.app import create_test_app


def test_wire_registers_default_deps() -> None:
    wiring.wire()
    deps = ports.get(CatalogDeps)
    assert isinstance(deps.search, OpenSearchIndex) and deps.search.alias == "nais-datasets"
    assert isinstance(deps.storage, StorageRegistry)
    assert isinstance(deps.scanner, NoopScanner)
    assert isinstance(deps.verification, DramatiqVerificationQueue)


def test_catalog_module_mounts_on_the_test_app() -> None:
    app = create_test_app(modules=[MODULE])
    assert [spec.name for spec in app.state.modules] == ["catalog"]
    assert ports.get(CatalogDeps) is not None


def test_get_deps_without_wiring_is_dependency_unavailable() -> None:
    with pytest.raises(ApiError) as caught:
        get_deps()
    assert caught.value.code == ErrorCode.DEPENDENCY_UNAVAILABLE


def test_fake_identity_knows_the_seed_organizations() -> None:
    fake = FakeIdentityPort()
    assert fake.get_organization_summary(ORG_B) == OrganizationSummary(
        ORG_B, "inst-b", "Institute B", "RESEARCH_INSTITUTE"
    )
    assert fake.get_organization_summary(ORG_NAIS).code == "nais"  # type: ignore[union-attr]
    assert set(fake.get_organization_summaries([ORG_A, ORG_B, UUID(int=1)])) == {ORG_A, ORG_B}


def test_lookup_falls_back_to_the_fake_without_identity_module(monkeypatch: pytest.MonkeyPatch) -> None:
    def missing(name: str) -> Any:
        raise ModuleNotFoundError(f"No module named {name!r}", name="api.modules.identity")

    monkeypatch.setattr(wiring.importlib, "import_module", missing)
    assert isinstance(wiring.default_organization_lookup(), FakeIdentityPort)


def test_installed_but_unwired_identity_is_dependency_unavailable() -> None:
    ports.reset()
    lookup = wiring.default_organization_lookup()
    assert isinstance(lookup, IdentityQueryAdapter)
    with pytest.raises(ApiError) as caught:
        lookup.get_organization_summary(ORG_B)
    assert caught.value.code == ErrorCode.DEPENDENCY_UNAVAILABLE


def test_lookup_uses_the_identity_public_port_when_provided() -> None:
    class Impl:  # only the method the catalog calls; cast because the test fake is partial
        def get_organization_summary(
            self, organization_id: UUID
        ) -> identity_public.OrganizationSummary | None:
            if organization_id != ORG_B:
                return None
            return identity_public.OrganizationSummary(
                organization_id=ORG_B, code="inst-b", name="Institute B (M01)", type="RESEARCH_INSTITUTE"
            )

    ports.reset()
    ports.provide(IdentityQueryPort, cast(IdentityQueryPort, Impl()))
    lookup = wiring.default_organization_lookup()
    expected = OrganizationSummary(ORG_B, "inst-b", "Institute B (M01)", "RESEARCH_INSTITUTE")
    assert lookup.get_organization_summary(ORG_B) == expected
    assert lookup.get_organization_summary(ORG_A) is None  # the real port answers, not the fake
    assert lookup.get_organization_summaries([ORG_B, ORG_A, ORG_B]) == {ORG_B: expected}


def test_scanner_selection() -> None:
    assert build_scanner("noop").scan("nais-inst-b", "k").status == "SKIPPED"
    with pytest.raises(ValueError, match="clamav"):
        build_scanner("clamav")
