"""M01 public surface for other modules: read DTOs and IdentityQueryPort (the port is defined here).

DTOs are field-identical to openapi components IdentityPublicProfile / OrganizationSummary. Other modules use
only these, CurrentUser, and IdentityQueryPort; they never read identity.* tables.
"""

from typing import Literal, Protocol
from uuid import UUID

from pydantic import BaseModel, ConfigDict

OrganizationType = Literal["RESEARCH_INSTITUTE", "UNIVERSITY", "COMPANY", "PLATFORM_OPERATOR"]
ActiveStatus = Literal["ACTIVE", "DISABLED"]
OrgRole = Literal["ORG_ADMIN", "DATA_STEWARD", "RESOURCE_MANAGER"]


class OrganizationSummary(BaseModel):
    model_config = ConfigDict(frozen=True)

    organization_id: UUID
    code: str
    name: str
    type: OrganizationType


class IdentityPublicProfile(BaseModel):
    model_config = ConfigDict(frozen=True)

    user_id: UUID
    display_name: str
    organization_id: UUID
    organization_name: str | None = None
    status: ActiveStatus
    national_researcher_number: str | None = None


class IdentityQueryPort(Protocol):
    """Read port for other modules (spec §8). Look it up with api.platform.ports.get(IdentityQueryPort)."""

    def get_public_profile(self, user_id: UUID) -> IdentityPublicProfile | None: ...

    def get_public_profiles(self, user_ids: list[UUID]) -> dict[UUID, IdentityPublicProfile]: ...

    def get_organization_summary(self, organization_id: UUID) -> OrganizationSummary | None: ...

    def is_active_user(self, user_id: UUID) -> bool:
        """User ACTIVE and membership ACTIVE."""
        ...

    def has_org_role(self, user_id: UUID, organization_id: UUID, role: OrgRole) -> bool: ...

    def list_users_with_org_role(self, organization_id: UUID, role: OrgRole) -> list[UUID]:
        """ACTIVE users with an ACTIVE membership holding role (M09 notification recipients)."""
        ...

    def get_email(self, user_id: UUID) -> str | None:
        """M09 mail delivery only. Other modules must not use it."""
        ...
