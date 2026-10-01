"""Seed organizations and users (10_SEED_DATA.md §2-3). Kept in code: seed() must not read docs at runtime.

Keycloak user id == NAIS user_id == token sub (infra/keycloak/import/realm-nais.json uses the same ids).
"""

from dataclasses import dataclass
from uuid import UUID


def fixed_id(suffix: str) -> UUID:
    """00000000-0000-7000-8000-00000000XXXX with the given hex suffix."""
    return UUID(f"00000000-0000-7000-8000-{suffix.rjust(12, '0')}")


@dataclass(frozen=True)
class SeedOrganization:
    organization_id: UUID
    code: str
    name: str
    type: str


@dataclass(frozen=True)
class SeedUser:
    user_id: UUID
    email: str
    display_name: str
    org_code: str
    org_roles: tuple[str, ...] = ()
    platform_roles: tuple[str, ...] = ()
    membership_status: str = "ACTIVE"

    @property
    def keycloak_sub(self) -> str:
        return str(self.user_id)


ORGANIZATIONS: tuple[SeedOrganization, ...] = (
    SeedOrganization(fixed_id("1"), "nais", "NAIS", "PLATFORM_OPERATOR"),
    SeedOrganization(fixed_id("a"), "inst-a", "Institute A", "RESEARCH_INSTITUTE"),
    SeedOrganization(fixed_id("b"), "inst-b", "Institute B", "RESEARCH_INSTITUTE"),
)

USERS: tuple[SeedUser, ...] = (
    SeedUser(fixed_id("101"), "admin@nais.local", "NAIS Admin", "nais", ("ORG_ADMIN",), ("PLATFORM_ADMIN",)),
    SeedUser(fixed_id("a01"), "a.admin@inst-a.local", "A Admin", "inst-a", ("ORG_ADMIN",)),
    SeedUser(fixed_id("a02"), "a.researcher@inst-a.local", "A Researcher", "inst-a"),
    SeedUser(fixed_id("a03"), "a.steward@inst-a.local", "A Steward", "inst-a", ("DATA_STEWARD",)),
    SeedUser(fixed_id("b01"), "b.admin@inst-b.local", "B Admin", "inst-b", ("ORG_ADMIN",)),
    SeedUser(fixed_id("b02"), "b.researcher@inst-b.local", "B Researcher", "inst-b"),
    SeedUser(fixed_id("b03"), "b.steward@inst-b.local", "B Steward", "inst-b", ("DATA_STEWARD",)),
    SeedUser(
        fixed_id("b04"), "b.disabled@inst-b.local", "B Disabled", "inst-b", membership_status="DISABLED"
    ),
)

ORGS_BY_CODE: dict[str, SeedOrganization] = {org.code: org for org in ORGANIZATIONS}
USERS_BY_EMAIL: dict[str, SeedUser] = {user.email: user for user in USERS}
