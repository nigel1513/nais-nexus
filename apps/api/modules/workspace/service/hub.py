"""Data-Hub reads (spec §4; openapi getHubOverview/listDatasetProjects/listDatasetActivity).

Visibility is always the catalog's (D-012): the overview uses one batched list_visible_dataset_summaries call, the
per-dataset reads is_visible (else 404). Counts come from this module's own tables: live project inputs
(most_used), governance.access.requested.v1 occurrences of the last 7 days (trending), and dataset_activity rows
written by handlers.py.
"""

from collections.abc import Iterable, Sequence
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from api.modules.catalog.public import DatasetSummary
from api.modules.workspace import repo
from api.modules.workspace.deps import WorkspaceDeps
from api.modules.workspace.errors import not_found
from api.modules.workspace.paging import keyset_page, sort_key
from api.modules.workspace.schemas import DatasetActivity, DatasetProjectsResult, HubOverview
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.pagination import Page, PageParams

RAIL_SIZE = 6
TRENDING_WINDOW = timedelta(days=7)
CONTROLLED_LEVELS = frozenset({"CONTROLLED", "SENSITIVE"})
USED_IN_PROJECT = "USED_IN_PROJECT"


def _card(summary: DatasetSummary, metric: int | None) -> dict[str, object]:
    return {
        "dataset_id": summary.dataset_id,
        "title": summary.title,
        "owner_organization_name": summary.owner_organization_name,
        "subject_labels": list(summary.subject_labels),
        "access_level": summary.access_level,
        "readiness_overall": summary.readiness_overall,
        "updated_at": summary.updated_at,
        "metric": metric,
    }


def _counted_rail(summaries: Iterable[DatasetSummary], counts: dict[UUID, int]) -> list[dict[str, object]]:
    """Datasets with a positive count, highest first (ties: newest publication, then title)."""
    ranked = sorted(
        (s for s in summaries if counts.get(s.dataset_id, 0) > 0),
        key=lambda s: (-counts[s.dataset_id], -_published_ts(s), s.title, str(s.dataset_id)),
    )
    return [_card(s, counts[s.dataset_id]) for s in ranked[:RAIL_SIZE]]


def _published_ts(summary: DatasetSummary) -> float:
    return summary.latest_published_at.timestamp() if summary.latest_published_at else 0.0


def overview(session: Session, deps: WorkspaceDeps, user: CurrentUser) -> HubOverview:
    summaries = [s for s in deps.catalog.list_visible_dataset_summaries(user) if s.status == "ACTIVE"]
    requests = repo.access_request_counts(session, since=clock.now() - TRENDING_WINDOW)
    uses = repo.live_input_counts(session)
    recent = sorted(
        (s for s in summaries if s.latest_published_at is not None),
        key=lambda s: (-_published_ts(s), str(s.dataset_id)),
    )
    return HubOverview.model_validate(
        {
            "rails": {
                "trending": _counted_rail(summaries, requests),
                "recent": [_card(s, None) for s in recent[:RAIL_SIZE]],
                "most_used": _counted_rail(summaries, uses),
            },
            "organizations": _organizations(summaries),
        }
    )


@dataclass
class _OrgStat:
    organization_id: UUID
    name: str
    dataset_count: int = 0
    public_count: int = 0
    controlled_count: int = 0
    last_updated_at: datetime | None = None


def _organizations(summaries: list[DatasetSummary]) -> list[dict[str, object]]:
    """One row per owner organization of the ACTIVE datasets the caller sees; most datasets first."""
    stats: dict[UUID, _OrgStat] = {}
    for s in summaries:
        stat = stats.setdefault(
            s.owner_organization_id, _OrgStat(s.owner_organization_id, s.owner_organization_name)
        )
        stat.dataset_count += 1
        stat.public_count += s.access_level == "PUBLIC"
        stat.controlled_count += s.access_level in CONTROLLED_LEVELS
        if stat.last_updated_at is None or s.updated_at > stat.last_updated_at:
            stat.last_updated_at = s.updated_at
    ranked = sorted(stats.values(), key=lambda o: (-o.dataset_count, o.name, str(o.organization_id)))
    return [asdict(o) for o in ranked]


def _require_visible(deps: WorkspaceDeps, user: CurrentUser, dataset_id: UUID) -> None:
    if not deps.catalog.is_visible(user, dataset_id):
        raise not_found("Dataset")


def dataset_projects(
    session: Session, deps: WorkspaceDeps, user: CurrentUser, dataset_id: UUID
) -> DatasetProjectsResult:
    _require_visible(deps, user, dataset_id)
    uses = repo.live_inputs_of_dataset(session, dataset_id)
    projects = deps.projects
    mine = set(projects.list_project_ids_for_member(user.user_id))
    shown = []
    for use in uses:
        if use["project_id"] in mine and (summary := projects.get_summary(use["project_id"])) is not None:
            shown.append((summary, use["added_at"]))
    leads = deps.people.get_organization_names([s.lead_organization_id.root for s, _ in shown])
    return DatasetProjectsResult.model_validate(
        {
            "items": [
                {
                    "project_id": summary.project_id,
                    "name": summary.name,
                    "lead_organization_name": summary.lead_organization_name
                    or leads.get(summary.lead_organization_id.root, ""),
                    "input_added_at": added_at,
                }
                for summary, added_at in shown
            ],
            "hidden_count": len(uses) - len(shown),
        }
    )


def dataset_activity(
    session: Session, deps: WorkspaceDeps, user: CurrentUser, dataset_id: UUID, params: PageParams
) -> Page[DatasetActivity]:
    """Project-linked rows reveal the project (id, name, actor) only to its members (contract: project_id)."""
    after = sort_key(params)
    _require_visible(deps, user, dataset_id)
    rows = repo.activity_page(session, dataset_id, after=after, limit=params.limit + 1)
    return keyset_page(
        rows, params.limit, ("occurred_at", "activity_id"), lambda shown: _activity_views(deps, user, shown)
    )


def _activity_views(
    deps: WorkspaceDeps, user: CurrentUser, rows: Sequence[RowMapping]
) -> list[DatasetActivity]:
    projects = deps.projects
    mine = (
        set(projects.list_project_ids_for_member(user.user_id))
        if any(r["project_id"] for r in rows)
        else set()
    )

    def shown(project_id: UUID | None) -> bool:
        return project_id is None or project_id in mine

    names = deps.people.get_display_names(
        [r["actor_id"] for r in rows if r["actor_id"] and shown(r["project_id"])]
    )
    project_names: dict[UUID, str | None] = {}

    def project_name(project_id: UUID) -> str | None:
        if project_id not in project_names:
            summary = projects.get_summary(project_id)
            project_names[project_id] = summary.name if summary else None
        return project_names[project_id]

    views: list[DatasetActivity] = []
    for r in rows:
        visible = shown(r["project_id"])
        label = r["label"]
        if r["type"] == USED_IN_PROJECT:
            label = project_name(r["project_id"]) if visible else None
        views.append(
            DatasetActivity.model_validate(
                {
                    "activity_id": r["activity_id"],
                    "dataset_id": r["dataset_id"],
                    "type": r["type"],
                    "label": label,
                    "ref_id": r["ref_id"] if visible else None,
                    "actor_display_name": names.get(r["actor_id"]) if visible and r["actor_id"] else None,
                    "project_id": r["project_id"] if visible else None,
                    "occurred_at": r["occurred_at"],
                }
            )
        )
    return views
