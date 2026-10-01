"""FakeIdentityQueryPort backed by the 10_SEED_DATA users (M02 §3, mock-first Wave 1)."""

from collections.abc import Iterable
from uuid import UUID

from api.modules.identity.public import IdentityPublicProfile, OrganizationSummary
from api.modules.project.seed_data import SEED_ORGANIZATIONS, SEED_USERS, SeedOrganization, SeedUser


class FakeIdentityQueryPort:
    """Implements every method of api.modules.identity.public.IdentityQueryPort."""

    def __init__(self, users: Iterable[SeedUser], organizations: Iterable[SeedOrganization]) -> None:
        self._users = {user.user_id: user for user in users}
        self._organizations = {org.organization_id: org for org in organizations}
        self._disabled = {user.user_id for user in self._users.values() if not user.active}

    @classmethod
    def with_seed_users(cls) -> "FakeIdentityQueryPort":
        return cls(SEED_USERS, SEED_ORGANIZATIONS)

    def disable(self, user_id: UUID) -> None:
        self._disabled.add(user_id)

    def get_public_profile(self, user_id: UUID) -> IdentityPublicProfile | None:
        user = self._users.get(user_id)
        if user is None:
            return None
        organization = self._organizations.get(user.organization_id)
        return IdentityPublicProfile(
            user_id=user.user_id,
            display_name=user.display_name,
            organization_id=user.organization_id,
            organization_name=organization.name if organization else None,
            status="DISABLED" if user_id in self._disabled else "ACTIVE",
        )

    def get_public_profiles(self, user_ids: list[UUID]) -> dict[UUID, IdentityPublicProfile]:
        profiles: dict[UUID, IdentityPublicProfile] = {}
        for user_id in user_ids:
            profile = self.get_public_profile(user_id)
            if profile is not None:
                profiles[user_id] = profile
        return profiles

    def get_organization_summary(self, organization_id: UUID) -> OrganizationSummary | None:
        organization = self._organizations.get(organization_id)
        if organization is None:
            return None
        return OrganizationSummary.model_validate(
            {
                "organization_id": organization.organization_id,
                "code": organization.code,
                "name": organization.name,
                "type": organization.type,
            }
        )

    def is_active_user(self, user_id: UUID) -> bool:
        return user_id in self._users and user_id not in self._disabled

    def has_org_role(self, user_id: UUID, organization_id: UUID, role: str) -> bool:
        user = self._users.get(user_id)
        return (
            user is not None
            and user_id not in self._disabled
            and user.organization_id == organization_id
            and role in user.org_roles
        )

    def list_users_with_org_role(self, organization_id: UUID, role: str) -> list[UUID]:
        return [
            user.user_id
            for user in self._users.values()
            if self.has_org_role(user.user_id, organization_id, role)
        ]

    def get_email(self, user_id: UUID) -> str | None:
        user = self._users.get(user_id)
        return user.email if user else None
