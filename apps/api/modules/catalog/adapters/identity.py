"""Organization lookup: M01's public IdentityQueryPort (W1-D1 key: api.modules.identity.public.IdentityQueryPort).
wiring.default_organization_lookup() picks FakeIdentityPort only when the identity package is not installed."""

from collections.abc import Sequence
from uuid import UUID

from api.modules.catalog.interfaces import OrganizationSummary
from api.modules.identity import public as identity_public
from api.modules.identity.public import IdentityQueryPort
from api.platform import ports
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode

SEED_ORGANIZATIONS: tuple[OrganizationSummary, ...] = (
    OrganizationSummary(UUID("00000000-0000-7000-8000-000000000001"), "nais", "NAIS", "PLATFORM_OPERATOR"),
    OrganizationSummary(
        UUID("00000000-0000-7000-8000-00000000000a"), "inst-a", "Institute A", "RESEARCH_INSTITUTE"
    ),
    OrganizationSummary(
        UUID("00000000-0000-7000-8000-00000000000b"), "inst-b", "Institute B", "RESEARCH_INSTITUTE"
    ),
)


class FakeIdentityPort:
    def __init__(self, organizations: Sequence[OrganizationSummary] = SEED_ORGANIZATIONS) -> None:
        self._by_id = {org.organization_id: org for org in organizations}

    def get_organization_summary(self, organization_id: UUID) -> OrganizationSummary | None:
        return self._by_id.get(organization_id)

    def get_organization_summaries(self, ids: Sequence[UUID]) -> dict[UUID, OrganizationSummary]:
        return {org_id: self._by_id[org_id] for org_id in ids if org_id in self._by_id}


def _convert(summary: identity_public.OrganizationSummary) -> OrganizationSummary:
    return OrganizationSummary(
        organization_id=summary.organization_id, code=summary.code, name=summary.name, type=summary.type
    )


class IdentityQueryAdapter:
    """Wraps M01's IdentityQueryPort, looked up per call (wiring order does not matter).
    Identity installed but its port not provided -> 503 DEPENDENCY_UNAVAILABLE (fail closed)."""

    def _port(self) -> IdentityQueryPort:
        try:
            return ports.get(IdentityQueryPort)
        except ports.PortNotProvided as exc:
            raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Identity module is not wired.") from exc

    def get_organization_summary(self, organization_id: UUID) -> OrganizationSummary | None:
        summary = self._port().get_organization_summary(organization_id)
        return None if summary is None else _convert(summary)

    def get_organization_summaries(self, ids: Sequence[UUID]) -> dict[UUID, OrganizationSummary]:
        result: dict[UUID, OrganizationSummary] = {}
        for org_id in dict.fromkeys(ids):
            summary = self.get_organization_summary(org_id)
            if summary is not None:
                result[org_id] = summary
        return result
