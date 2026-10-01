"""HTTP models of the identity API (shapes of openapi.yaml components Me, Organization, OrganizationMembership)."""

from datetime import datetime
from typing import Annotated, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from api.modules.identity.public import ActiveStatus, OrganizationSummary

NTIS_PATTERN = r"^[0-9]{8}$"


class MeOut(BaseModel):
    user_id: UUID
    display_name: str
    email: str
    status: ActiveStatus
    organization: OrganizationSummary
    org_roles: list[str]
    platform_roles: list[str]
    national_researcher_number: str | None = None


class MeUpdateIn(BaseModel):
    """PATCH /me. null clears the number; at least one field is required."""

    model_config = ConfigDict(extra="forbid")

    national_researcher_number: Annotated[str, StringConstraints(pattern=NTIS_PATTERN)] | None = None

    @model_validator(mode="after")
    def _not_empty(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("at least one field is required")
        return self


class OrganizationOut(OrganizationSummary):
    ror_id: str | None = None
    homepage_url: str | None = None
    member_count: int
    created_at: datetime


class MembershipOut(BaseModel):
    user_id: UUID
    organization_id: UUID
    display_name: str
    email: str
    roles: list[str]
    status: ActiveStatus
    started_at: datetime | None = None
    updated_at: datetime


class TransferIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    organization_id: UUID
    roles: list[str] = Field(default_factory=list)


class MemberUpdateIn(BaseModel):
    """PATCH body. roles are plain strings on purpose: a non-org role is 422 ROLE_NOT_ASSIGNABLE, not a schema error."""

    model_config = ConfigDict(extra="forbid")

    roles: list[str] | None = None
    status: ActiveStatus | None = None
