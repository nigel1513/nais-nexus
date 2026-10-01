"""Response shapes for openapi Project / ProjectSummary / ProjectMember. Optional names are omitted, not null."""

from collections.abc import Iterable, Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import RowMapping
from sqlalchemy.orm import Session

from api.modules.project import repository as repo
from api.modules.project.identity import IdentityPublicProfile, IdentityQueryPort
from api.modules.project.service import ProjectAccess


def summary_view(project: RowMapping, *, my_role: str | None, member_count: int) -> dict[str, Any]:
    return {
        "project_id": project["project_id"],
        "name": project["name"],
        "status": project["status"],
        "visibility": project["visibility"],
        "lead_organization_id": project["lead_organization_id"],
        "my_role": my_role,
        "member_count": member_count,
        "updated_at": project["updated_at"],
    }


def detail_view(session: Session, identity: IdentityQueryPort, access: ProjectAccess) -> dict[str, Any]:
    project = access.project
    project_id = project["project_id"]
    organizations: list[dict[str, Any]] = []
    for row in repo.list_organizations(session, project_id):
        item: dict[str, Any] = {"organization_id": row["organization_id"], "role": row["role"]}
        summary = identity.get_organization_summary(row["organization_id"])
        if summary is not None:
            item["name"] = summary.name
        organizations.append(item)
    return {
        **summary_view(
            project, my_role=access.my_role, member_count=repo.count_active_members(session, project_id)
        ),
        "description": project["description"],
        "keywords": list(project["keywords"]),
        "start_date": project["start_date"],
        "end_date": project["end_date"],
        "organizations": organizations,
        "created_by": project["created_by"],
        "created_at": project["created_at"],
        "archived_at": project["archived_at"],
    }


def _organization_names(
    identity: IdentityQueryPort, organization_ids: set[UUID], profiles: Iterable[IdentityPublicProfile]
) -> dict[UUID, str]:
    names = {p.organization_id: p.organization_name for p in profiles if p.organization_name}
    for organization_id in organization_ids - names.keys():
        summary = identity.get_organization_summary(organization_id)
        if summary is not None:
            names[organization_id] = summary.name
    return names


def member_view(
    member: RowMapping, profile: IdentityPublicProfile | None, org_names: dict[UUID, str]
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "project_id": member["project_id"],
        "user_id": member["user_id"],
        "organization_id": member["organization_id"],
        "role": member["role"],
        "joined_at": member["joined_at"],
        "added_by": member["added_by"],
    }
    if profile is not None:
        item["display_name"] = profile.display_name
    organization_name = org_names.get(member["organization_id"])
    if organization_name:
        item["organization_name"] = organization_name
    return item


def members_view(identity: IdentityQueryPort, members: Sequence[RowMapping]) -> list[dict[str, Any]]:
    if not members:
        return []
    profiles = identity.get_public_profiles([member["user_id"] for member in members])
    org_names = _organization_names(
        identity, {member["organization_id"] for member in members}, profiles.values()
    )
    return [member_view(member, profiles.get(member["user_id"]), org_names) for member in members]
