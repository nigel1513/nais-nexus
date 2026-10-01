"""M01 public surface for other modules: read DTOs (+ IdentityQueryPort, added with the query adapter).

Field-identical to openapi components IdentityPublicProfile / OrganizationSummary. Other modules use only these,
CurrentUser, and IdentityQueryPort; they never read identity.* tables.
"""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

OrganizationType = Literal["RESEARCH_INSTITUTE", "UNIVERSITY", "COMPANY", "PLATFORM_OPERATOR"]
ActiveStatus = Literal["ACTIVE", "DISABLED"]


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
