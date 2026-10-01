"""Fixed seed ids and identities from 10_SEED_DATA.md §2-4.

Kept as code: seed() must not read NAIS_PRD at runtime (docs are not in the image). The users/organizations
here also back the Wave 1 FakeIdentityQueryPort (M02 §3) and the test PrincipalResolver.
"""

from dataclasses import dataclass
from uuid import UUID


def seed_uuid(suffix: str) -> UUID:
    """10_SEED_DATA id format 00000000-0000-7000-8000-00000000XXXX (XXXX = hex suffix)."""
    return UUID(f"00000000-0000-7000-8000-{int(suffix, 16):012x}")


@dataclass(frozen=True)
class SeedOrganization:
    organization_id: UUID
    code: str
    name: str
    type: str


@dataclass(frozen=True)
class SeedUser:
    key: str
    user_id: UUID
    email: str
    display_name: str
    organization_id: UUID
    org_roles: frozenset[str] = frozenset()
    platform_roles: frozenset[str] = frozenset()
    active: bool = True


ORG_NAIS = seed_uuid("0001")
ORG_A = seed_uuid("000a")
ORG_B = seed_uuid("000b")

SEED_ORGANIZATIONS: tuple[SeedOrganization, ...] = (
    SeedOrganization(ORG_NAIS, "nais", "NAIS", "PLATFORM_OPERATOR"),
    SeedOrganization(ORG_A, "inst-a", "Institute A", "RESEARCH_INSTITUTE"),
    SeedOrganization(ORG_B, "inst-b", "Institute B", "RESEARCH_INSTITUTE"),
)

SEED_USERS: tuple[SeedUser, ...] = (
    SeedUser(
        "admin",
        seed_uuid("0101"),
        "admin@nais.local",
        "NAIS Admin",
        ORG_NAIS,
        frozenset({"ORG_ADMIN"}),
        frozenset({"PLATFORM_ADMIN"}),
    ),
    SeedUser(
        "a.admin", seed_uuid("0a01"), "a.admin@inst-a.local", "A Admin", ORG_A, frozenset({"ORG_ADMIN"})
    ),
    SeedUser("a.researcher", seed_uuid("0a02"), "a.researcher@inst-a.local", "A Researcher", ORG_A),
    SeedUser(
        "a.steward",
        seed_uuid("0a03"),
        "a.steward@inst-a.local",
        "A Steward",
        ORG_A,
        frozenset({"DATA_STEWARD"}),
    ),
    SeedUser(
        "b.admin", seed_uuid("0b01"), "b.admin@inst-b.local", "B Admin", ORG_B, frozenset({"ORG_ADMIN"})
    ),
    SeedUser("b.researcher", seed_uuid("0b02"), "b.researcher@inst-b.local", "B Researcher", ORG_B),
    SeedUser(
        "b.steward",
        seed_uuid("0b03"),
        "b.steward@inst-b.local",
        "B Steward",
        ORG_B,
        frozenset({"DATA_STEWARD"}),
    ),
    SeedUser("b.disabled", seed_uuid("0b04"), "b.disabled@inst-b.local", "B Disabled", ORG_B, active=False),
)

USERS_BY_KEY: dict[str, SeedUser] = {user.key: user for user in SEED_USERS}

SEED_PROJECT_ID = seed_uuid("1001")
SEED_PROJECT_NAME = "Seed: Battery Materials Joint Study"
SEED_OWNER_MEMBER_ID = seed_uuid("1101")
SEED_PARTNER_MEMBER_ID = seed_uuid("1102")
