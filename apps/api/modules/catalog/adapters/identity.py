"""Organization lookup: M01's public IdentityQueryPort (W1-D1 key: api.modules.identity.public.IdentityQueryPort).
wiring.default_organization_lookup() picks FakeIdentityPort only when the identity package is not installed."""

from collections.abc import Sequence
from dataclasses import replace
from uuid import UUID

from api.modules.catalog.interfaces import OrganizationSummary, PersonSummary
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

_NAIS, _A, _B = (org.organization_id for org in SEED_ORGANIZATIONS)


def _seed_user(suffix: str) -> UUID:
    return UUID(f"00000000-0000-7000-8000-00000000{suffix}")


SEED_PEOPLE: tuple[PersonSummary, ...] = (
    PersonSummary(_seed_user("0101"), "NAIS Admin", _NAIS, "NAIS", "ACTIVE"),
    PersonSummary(_seed_user("0a01"), "A Admin", _A, "Institute A", "ACTIVE"),
    PersonSummary(_seed_user("0a02"), "A Researcher", _A, "Institute A", "ACTIVE", "10000001"),
    PersonSummary(_seed_user("0a03"), "A Steward", _A, "Institute A", "ACTIVE", "10000003"),
    PersonSummary(_seed_user("0b01"), "B Admin", _B, "Institute B", "ACTIVE"),
    PersonSummary(_seed_user("0b02"), "B Researcher", _B, "Institute B", "ACTIVE", "10000002"),
    PersonSummary(_seed_user("0b03"), "B Steward", _B, "Institute B", "ACTIVE", "10000004"),
    PersonSummary(_seed_user("0b04"), "B Disabled", _B, "Institute B", "DISABLED"),
)
SEED_EMAILS = {
    _seed_user("0a03"): "a.steward@inst-a.local",
    _seed_user("0b03"): "b.steward@inst-b.local",
}


class FakeIdentityPort:
    def __init__(
        self,
        organizations: Sequence[OrganizationSummary] = SEED_ORGANIZATIONS,
        people: Sequence[PersonSummary] = SEED_PEOPLE,
    ) -> None:
        self._by_id = {org.organization_id: org for org in organizations}
        self._people = {person.user_id: person for person in people}

    def get_organization_summary(self, organization_id: UUID) -> OrganizationSummary | None:
        return self._by_id.get(organization_id)

    def get_organization_summaries(self, ids: Sequence[UUID]) -> dict[UUID, OrganizationSummary]:
        return {org_id: self._by_id[org_id] for org_id in ids if org_id in self._by_id}

    def get_people(self, ids: Sequence[UUID]) -> dict[UUID, PersonSummary]:
        return {i: self._people[i] for i in ids if i in self._people}

    def get_email(self, user_id: UUID) -> str | None:
        return SEED_EMAILS.get(user_id)

    def move(self, user_id: UUID, organization_id: UUID) -> None:
        """Test helper: simulate transferUserOrganization."""
        person = self._people[user_id]
        org = self._by_id[organization_id]
        self._people[user_id] = replace(person, organization_id=organization_id, organization_name=org.name)


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

    def get_people(self, ids: Sequence[UUID]) -> dict[UUID, PersonSummary]:
        if not ids:
            return {}
        profiles = self._port().get_public_profiles(list(dict.fromkeys(ids)))
        return {
            user_id: PersonSummary(
                user_id=p.user_id,
                display_name=p.display_name,
                organization_id=p.organization_id,
                organization_name=p.organization_name,
                status=p.status,
                national_researcher_number=p.national_researcher_number,
            )
            for user_id, p in profiles.items()
        }

    def get_email(self, user_id: UUID) -> str | None:
        return self._port().get_email(user_id)
