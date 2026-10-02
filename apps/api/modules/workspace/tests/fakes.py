"""In-memory stand-ins for the ports the workspace consumes (project, catalog, grants, people)."""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import UUID

from nais_contracts.api_models import ProjectSummary

from api.modules.catalog.public import AccessLevel, DatasetPolicyView, DatasetSummary, VersionView
from api.platform.auth import CurrentUser
from api.platform.ids import new_id

ORG_A = UUID("00000000-0000-7000-8000-00000000000a")
ORG_B = UUID("00000000-0000-7000-8000-00000000000b")
ORG_NAMES = {ORG_A: "Institute A", ORG_B: "Institute B"}
T0 = datetime(2026, 9, 1, tzinfo=UTC)


def _user(suffix: str, org: UUID, name: str, roles: frozenset[str] = frozenset()) -> CurrentUser:
    return CurrentUser(
        user_id=UUID(f"00000000-0000-7000-8000-00000000{suffix}"),
        organization_id=org,
        org_roles=roles,
        session_id=f"s-{suffix}",
        display_name=name,
    )


USERS: dict[str, CurrentUser] = {
    "a.researcher": _user("0a02", ORG_A, "A Researcher"),
    "a.viewer": _user("0a05", ORG_A, "A Viewer"),
    "a.outsider": _user("0a06", ORG_A, "A Outsider"),
    "a.owner": _user("0a01", ORG_A, "A Owner"),
    "b.researcher": _user("0b02", ORG_B, "B Researcher"),
    "b.steward": _user("0b03", ORG_B, "B Steward", frozenset({"DATA_STEWARD"})),
    "a.steward": _user("0a03", ORG_A, "A Steward", frozenset({"DATA_STEWARD"})),
}


@dataclass
class FakeProjects:
    """ProjectQueryPort: project_id -> {user_id: role}; archived projects keep roles but are not "active"."""

    roles: dict[UUID, dict[UUID, str]] = field(default_factory=dict)
    archived: set[UUID] = field(default_factory=set)
    names: dict[UUID, str] = field(default_factory=dict)
    lead: dict[UUID, UUID] = field(default_factory=dict)

    def add(self, project_id: UUID, user: CurrentUser, role: str) -> None:
        self.roles.setdefault(project_id, {})[user.user_id] = role
        self.names.setdefault(project_id, f"Project {str(project_id)[-4:]}")
        self.lead.setdefault(project_id, user.organization_id)

    def is_active_member(self, project_id: UUID, user_id: UUID) -> bool:
        return project_id not in self.archived and user_id in self.roles.get(project_id, {})

    def get_member_role(self, project_id: UUID, user_id: UUID) -> str | None:
        return self.roles.get(project_id, {}).get(user_id)

    def get_summary(self, project_id: UUID) -> ProjectSummary | None:
        if project_id not in self.names:
            return None
        return ProjectSummary.model_validate(
            {
                "project_id": project_id,
                "name": self.names[project_id],
                "status": "ARCHIVED" if project_id in self.archived else "ACTIVE",
                "visibility": "PRIVATE",
                "lead_organization_id": self.lead[project_id],
            }
        )

    def list_active_member_ids(self, project_id: UUID) -> list[UUID]:
        return list(self.roles.get(project_id, {}))

    def list_project_ids_for_member(self, user_id: UUID) -> list[UUID]:
        return [p for p, members in self.roles.items() if user_id in members]


@dataclass
class FakeCatalog:
    """CatalogQueryPort with the D-012 visibility rule; versions are "published" in insertion order."""

    datasets: dict[UUID, DatasetPolicyView] = field(default_factory=dict)
    versions: dict[UUID, VersionView] = field(default_factory=dict)
    published_at: dict[UUID, datetime] = field(default_factory=dict)
    subjects: dict[UUID, tuple[str, ...]] = field(default_factory=dict)
    summary_calls: int = 0

    def add_dataset(
        self, title: str, access_level: AccessLevel, owner: UUID = ORG_B, subjects: tuple[str, ...] = ()
    ) -> DatasetPolicyView:
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
        self.subjects[view.dataset_id] = subjects
        return view

    def add_version(
        self,
        dataset: DatasetPolicyView,
        label: str,
        status: Literal["DRAFT", "PUBLISHED", "WITHDRAWN"] = "PUBLISHED",
        published_at: datetime | None = None,
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
        if status == "PUBLISHED":
            self.published_at[view.dataset_version_id] = published_at or T0 + timedelta(
                hours=len(self.versions)
            )
        return view

    def set_access_level(self, dataset_id: UUID, level: AccessLevel) -> None:
        self.datasets[dataset_id] = replace(self.datasets[dataset_id], access_level=level)

    def withdraw(self, dataset_id: UUID) -> None:
        self.datasets[dataset_id] = replace(self.datasets[dataset_id], status="WITHDRAWN")

    def list_visible_dataset_summaries(self, ctx: CurrentUser) -> list[DatasetSummary]:
        self.summary_calls += 1
        summaries: list[DatasetSummary] = []
        for ds in self.datasets.values():
            if not self.is_visible(ctx, ds.dataset_id):
                continue
            latest = self.get_latest_published_version(ds.dataset_id)
            summaries.append(
                DatasetSummary(
                    dataset_id=ds.dataset_id,
                    title=ds.title,
                    owner_organization_id=ds.owner_organization_id,
                    owner_organization_name=ORG_NAMES.get(ds.owner_organization_id, ""),
                    access_level=ds.access_level,
                    status=ds.status,
                    subject_labels=self.subjects.get(ds.dataset_id, ()),
                    readiness_overall="PASS" if latest else None,
                    updated_at=T0,
                    latest_published_at=self.published_at[latest.dataset_version_id] if latest else None,
                )
            )
        return summaries

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

    def get_organization_names(self, organization_ids: Sequence[UUID]) -> dict[UUID, str]:
        return {i: ORG_NAMES[i] for i in organization_ids if i in ORG_NAMES}
