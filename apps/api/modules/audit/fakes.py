"""In-module fakes for the ports M09 consumes (mock-first, 02 §4), pre-loaded with 10_SEED_DATA rows.

Used by tests and as the runtime fallback when an adapter is not provided under the provider's public Protocol key
(see ports.py). Each fake implements the FULL provider Protocol and returns the provider DTOs.
"""

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from functools import lru_cache
from uuid import UUID

from nais_contracts.api_models import ProjectSummary

from api.modules.catalog.public import AccessLevel, DatasetPolicyView, DatasetSummary, VersionView
from api.modules.identity.public import IdentityPublicProfile, OrganizationSummary
from api.platform import ports
from api.platform.auth import CurrentUser


def seed_id(suffix: str) -> UUID:
    return UUID(f"00000000-0000-7000-8000-{suffix:0>12}")


ORG_NAIS, ORG_A, ORG_B = seed_id("0001"), seed_id("000a"), seed_id("000b")
ADMIN, A_ADMIN, A_RESEARCHER, A_STEWARD = seed_id("0101"), seed_id("0a01"), seed_id("0a02"), seed_id("0a03")
B_ADMIN, B_RESEARCHER, B_STEWARD, B_DISABLED = (
    seed_id("0b01"),
    seed_id("0b02"),
    seed_id("0b03"),
    seed_id("0b04"),
)
SEED_PROJECT = seed_id("1001")
DATASET_BATTERY, DATASET_OPEN, DATASET_QC = seed_id("2001"), seed_id("2002"), seed_id("2003")
DATASET_SENSOR, DATASET_DRAFT = seed_id("2004"), seed_id("2005")
SEED_GRANT = seed_id("4001")


@dataclass(frozen=True)
class FakeUser:
    user_id: UUID
    display_name: str
    email: str
    organization_id: UUID
    org_roles: frozenset[str] = frozenset()
    active: bool = True


SEED_ORGS: tuple[OrganizationSummary, ...] = (
    OrganizationSummary(organization_id=ORG_NAIS, code="nais", name="NAIS", type="PLATFORM_OPERATOR"),
    OrganizationSummary(organization_id=ORG_A, code="inst-a", name="Institute A", type="RESEARCH_INSTITUTE"),
    OrganizationSummary(organization_id=ORG_B, code="inst-b", name="Institute B", type="RESEARCH_INSTITUTE"),
)
_ALL_PURPOSES = ("ACADEMIC_RESEARCH", "AI_TRAINING", "COMMERCIAL_RESEARCH", "EDUCATION", "PUBLIC_INTEREST")


def _dataset(
    dataset_id: UUID, owner: UUID, title: str, level: AccessLevel, purposes: tuple[str, ...], max_days: int
) -> DatasetPolicyView:
    return DatasetPolicyView(
        dataset_id=dataset_id,
        owner_organization_id=owner,
        access_level=level,
        allowed_purposes=purposes,
        approval_required=level in ("CONTROLLED", "SENSITIVE"),
        max_grant_days=max_days,
        status="ACTIVE",
        title=title,
    )


SEED_USERS: tuple[FakeUser, ...] = (
    FakeUser(ADMIN, "NAIS Admin", "admin@nais.local", ORG_NAIS, frozenset({"ORG_ADMIN"})),
    FakeUser(A_ADMIN, "A Admin", "a.admin@inst-a.local", ORG_A, frozenset({"ORG_ADMIN"})),
    FakeUser(A_RESEARCHER, "A Researcher", "a.researcher@inst-a.local", ORG_A),
    FakeUser(A_STEWARD, "A Steward", "a.steward@inst-a.local", ORG_A, frozenset({"DATA_STEWARD"})),
    FakeUser(B_ADMIN, "B Admin", "b.admin@inst-b.local", ORG_B, frozenset({"ORG_ADMIN"})),
    FakeUser(B_RESEARCHER, "B Researcher", "b.researcher@inst-b.local", ORG_B),
    FakeUser(B_STEWARD, "B Steward", "b.steward@inst-b.local", ORG_B, frozenset({"DATA_STEWARD"})),
    FakeUser(B_DISABLED, "B Disabled", "b.disabled@inst-b.local", ORG_B, active=False),
)
SEED_DATASETS: tuple[DatasetPolicyView, ...] = (  # 10_SEED_DATA §5
    _dataset(
        DATASET_BATTERY,
        ORG_B,
        "Battery Cycling Measurements",
        "CONTROLLED",
        ("ACADEMIC_RESEARCH", "AI_TRAINING"),
        180,
    ),
    _dataset(DATASET_OPEN, ORG_B, "Open Materials Properties", "PUBLIC", _ALL_PURPOSES, 365),
    _dataset(DATASET_QC, ORG_B, "Inst-B Internal QC Logs", "INTERNAL", ("ACADEMIC_RESEARCH",), 90),
    _dataset(DATASET_SENSOR, ORG_A, "Facility Sensor Streams", "SENSITIVE", ("ACADEMIC_RESEARCH",), 30),
    _dataset(DATASET_DRAFT, ORG_A, "Electrolyte Screening (draft)", "CONTROLLED", ("AI_TRAINING",), 90),
)


class FakeIdentity:
    """Implements api.modules.identity.public.IdentityQueryPort."""

    def __init__(self, users: Iterable[FakeUser], orgs: Iterable[OrganizationSummary] = SEED_ORGS) -> None:
        self.users = {u.user_id: u for u in users}
        self.orgs = {o.organization_id: o for o in orgs}

    def get_public_profile(self, user_id: UUID) -> IdentityPublicProfile | None:
        return self.get_public_profiles([user_id]).get(user_id)

    def get_public_profiles(self, user_ids: list[UUID]) -> dict[UUID, IdentityPublicProfile]:
        profiles: dict[UUID, IdentityPublicProfile] = {}
        for uid in user_ids:
            user = self.users.get(uid)
            if user is None:
                continue
            org = self.orgs.get(user.organization_id)
            profiles[uid] = IdentityPublicProfile(
                user_id=uid,
                display_name=user.display_name,
                organization_id=user.organization_id,
                organization_name=org.name if org is not None else None,
                status="ACTIVE" if user.active else "DISABLED",
            )
        return profiles

    def get_organization_summary(self, organization_id: UUID) -> OrganizationSummary | None:
        return self.orgs.get(organization_id)

    def is_active_user(self, user_id: UUID) -> bool:
        user = self.users.get(user_id)
        return user is not None and user.active

    def list_users_with_org_role(self, organization_id: UUID, role: str) -> list[UUID]:
        return [
            u.user_id
            for u in self.users.values()
            if u.organization_id == organization_id and role in u.org_roles and u.active
        ]

    def has_org_role(self, user_id: UUID, organization_id: UUID, role: str) -> bool:
        user = self.users.get(user_id)
        return (
            user is not None
            and user.active
            and user.organization_id == organization_id
            and role in user.org_roles
        )

    def get_email(self, user_id: UUID) -> str | None:
        user = self.users.get(user_id)
        return user.email if user is not None else None


class FakeProjects:
    """Implements api.modules.project.public.ProjectQueryPort. members: project -> {user: project role}."""

    def __init__(self, members: Mapping[UUID, Mapping[UUID, str]], archived: Iterable[UUID] = ()) -> None:
        self.members = {project: dict(users) for project, users in members.items()}
        self.archived = set(archived)

    def archive(self, project_id: UUID) -> None:
        self.archived.add(project_id)

    def is_active_member(self, project_id: UUID, user_id: UUID) -> bool:
        return project_id not in self.archived and user_id in self.members.get(project_id, {})

    def get_member_role(self, project_id: UUID, user_id: UUID) -> str | None:
        return self.members.get(project_id, {}).get(user_id)

    def get_summary(self, project_id: UUID) -> ProjectSummary | None:
        return None  # M09 never reads project summaries; the fake carries no project metadata

    def list_active_member_ids(self, project_id: UUID) -> list[UUID]:
        return list(self.members.get(project_id, {}))

    def list_project_ids_for_member(self, user_id: UUID) -> list[UUID]:
        return [project for project, users in self.members.items() if user_id in users]


class FakeCatalog:
    """Implements api.modules.catalog.public.CatalogQueryPort (M09 only uses get_policy_view)."""

    def __init__(self, datasets: Iterable[DatasetPolicyView]) -> None:
        self.datasets = {d.dataset_id: d for d in datasets}

    def get_policy_view(self, dataset_id: UUID) -> DatasetPolicyView | None:
        return self.datasets.get(dataset_id)

    def get_version(self, dataset_version_id: UUID) -> VersionView | None:
        return None  # M09 never reads versions

    def get_latest_published_version(self, dataset_id: UUID) -> VersionView | None:
        return None  # M09 never reads versions

    def is_visible(self, ctx: CurrentUser, dataset_id: UUID) -> bool:
        raise NotImplementedError  # M09 never calls is_visible; visibility is the catalog's decision (D-012)

    def list_visible_dataset_summaries(self, ctx: CurrentUser) -> list[DatasetSummary]:
        raise NotImplementedError  # M09 never lists datasets


class FakeGrants:
    """Implements GrantQueryPort (consumer-side, api.modules.audit.ports; M04 arrives in Wave 2)."""

    def __init__(self, subjects: Mapping[UUID, Iterable[UUID]]) -> None:
        self.subjects = {dataset: list(users) for dataset, users in subjects.items()}

    def list_active_grant_subjects(self, dataset_id: UUID) -> list[UUID]:
        return list(self.subjects.get(dataset_id, []))


@lru_cache(maxsize=1)
def seed_identity() -> FakeIdentity:
    return FakeIdentity(SEED_USERS)


@lru_cache(maxsize=1)
def seed_projects() -> FakeProjects:
    return FakeProjects({SEED_PROJECT: {A_RESEARCHER: "PROJECT_OWNER", B_RESEARCHER: "RESEARCHER"}})


@lru_cache(maxsize=1)
def seed_catalog() -> FakeCatalog:
    return FakeCatalog(SEED_DATASETS)


@lru_cache(maxsize=1)
def seed_grants() -> FakeGrants:
    return FakeGrants({DATASET_BATTERY: [A_RESEARCHER]})


def provide_seed_ports() -> None:
    from api.modules.audit import ports as audit_ports  # local import: ports imports this module

    ports.provide(audit_ports.IdentityQueryPort, seed_identity())
    ports.provide(audit_ports.ProjectQueryPort, seed_projects())
    ports.provide(audit_ports.CatalogQueryPort, seed_catalog())
    ports.provide(audit_ports.GrantQueryPort, seed_grants())
