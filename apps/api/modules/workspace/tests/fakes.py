"""In-memory stand-ins for the ports the workspace consumes (project, catalog, grants, people)."""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field, replace
from typing import Literal
from uuid import UUID

from nais_contracts.api_models import ProjectSummary

from api.modules.catalog.public import AccessLevel, DatasetPolicyView, VersionView
from api.platform.auth import CurrentUser
from api.platform.ids import new_id

ORG_A = UUID("00000000-0000-7000-8000-00000000000a")
ORG_B = UUID("00000000-0000-7000-8000-00000000000b")


def _user(suffix: str, org: UUID, name: str) -> CurrentUser:
    return CurrentUser(
        user_id=UUID(f"00000000-0000-7000-8000-00000000{suffix}"),
        organization_id=org,
        session_id=f"s-{suffix}",
        display_name=name,
    )


USERS: dict[str, CurrentUser] = {
    "a.researcher": _user("0a02", ORG_A, "A Researcher"),
    "a.viewer": _user("0a05", ORG_A, "A Viewer"),
    "a.outsider": _user("0a06", ORG_A, "A Outsider"),
    "b.researcher": _user("0b02", ORG_B, "B Researcher"),
}


@dataclass
class FakeProjects:
    """ProjectQueryPort: project_id -> {user_id: role}; archived projects keep roles but are not "active"."""

    roles: dict[UUID, dict[UUID, str]] = field(default_factory=dict)
    archived: set[UUID] = field(default_factory=set)

    def add(self, project_id: UUID, user: CurrentUser, role: str) -> None:
        self.roles.setdefault(project_id, {})[user.user_id] = role

    def is_active_member(self, project_id: UUID, user_id: UUID) -> bool:
        return project_id not in self.archived and user_id in self.roles.get(project_id, {})

    def get_member_role(self, project_id: UUID, user_id: UUID) -> str | None:
        return self.roles.get(project_id, {}).get(user_id)

    def get_summary(self, project_id: UUID) -> ProjectSummary | None:
        return None

    def list_active_member_ids(self, project_id: UUID) -> list[UUID]:
        return list(self.roles.get(project_id, {}))

    def list_project_ids_for_member(self, user_id: UUID) -> list[UUID]:
        return [p for p, members in self.roles.items() if user_id in members]


@dataclass
class FakeCatalog:
    """CatalogQueryPort with the D-012 visibility rule; versions are "published" in insertion order."""

    datasets: dict[UUID, DatasetPolicyView] = field(default_factory=dict)
    versions: dict[UUID, VersionView] = field(default_factory=dict)

    def add_dataset(self, title: str, access_level: AccessLevel, owner: UUID = ORG_B) -> DatasetPolicyView:
        view = DatasetPolicyView(
            dataset_id=new_id(),
            owner_organization_id=owner,
            access_level=access_level,
            allowed_purposes=("ACADEMIC_RESEARCH",),
            approval_required=access_level in ("CONTROLLED", "SENSITIVE"),
            max_grant_days=180,
            status="ACTIVE",
            title=title,
        )
        self.datasets[view.dataset_id] = view
        return view

    def add_version(
        self,
        dataset: DatasetPolicyView,
        label: str,
        status: Literal["DRAFT", "PUBLISHED", "WITHDRAWN"] = "PUBLISHED",
    ) -> VersionView:
        view = VersionView(
            dataset_version_id=new_id(),
            dataset_id=dataset.dataset_id,
            owner_organization_id=dataset.owner_organization_id,
            version_label=label,
            status=status,
            manifest_sha256=None,
            metadata_snapshot={} if status != "DRAFT" else None,
            files=(),
        )
        self.versions[view.dataset_version_id] = view
        return view

    def set_access_level(self, dataset_id: UUID, level: AccessLevel) -> None:
        self.datasets[dataset_id] = replace(self.datasets[dataset_id], access_level=level)

    def get_policy_view(self, dataset_id: UUID) -> DatasetPolicyView | None:
        return self.datasets.get(dataset_id)

    def get_version(self, dataset_version_id: UUID) -> VersionView | None:
        return self.versions.get(dataset_version_id)

    def get_latest_published_version(self, dataset_id: UUID) -> VersionView | None:
        published = [
            v for v in self.versions.values() if v.dataset_id == dataset_id and v.status == "PUBLISHED"
        ]
        return published[-1] if published else None

    def is_visible(self, ctx: CurrentUser, dataset_id: UUID) -> bool:
        ds = self.datasets.get(dataset_id)
        if ds is None:
            return False
        if ctx.is_platform_admin or ctx.organization_id == ds.owner_organization_id:
            return True
        return (
            ds.status == "ACTIVE"
            and ds.access_level != "INTERNAL"
            and self.get_latest_published_version(dataset_id) is not None
        )


@dataclass
class FakeGrants:
    """GrantQueryPort: ACTIVE grants as (user_id, dataset_id) pairs."""

    active: set[tuple[UUID, UUID]] = field(default_factory=set)

    def grant(self, user: CurrentUser, dataset_id: UUID) -> None:
        self.active.add((user.user_id, dataset_id))

    def revoke(self, user: CurrentUser, dataset_id: UUID) -> None:
        self.active.discard((user.user_id, dataset_id))

    def has_active_grant(self, user_id: UUID, dataset_id: UUID) -> bool:
        return (user_id, dataset_id) in self.active


class FakePeople:
    """DisplayNameLookup backed by USERS."""

    def __init__(self, users: Iterable[CurrentUser] = USERS.values()) -> None:
        self._names = {u.user_id: u.display_name for u in users}

    def get_display_names(self, user_ids: Sequence[UUID]) -> dict[UUID, str]:
        return {i: self._names[i] for i in user_ids if i in self._names}
