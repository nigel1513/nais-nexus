"""M02 HTTP surface (openapi tag `projects`). Handlers stay thin: service enforces rules, views shape bodies."""

from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response

from api.modules.project import repository as repo
from api.modules.project import service, views
from api.modules.project.identity import IdentityQueryPort, get_identity_port
from api.modules.project.schemas import MemberAddIn, MemberRoleIn, ProjectCreateIn, ProjectUpdateIn
from api.modules.project.settings import ProjectSettings, get_project_settings
from api.platform.auth import CurrentUserDep
from api.platform.db import SessionDep
from api.platform.pagination import PageParams, build_page, page_params

router = APIRouter(tags=["projects"])

IdentityDep = Annotated[IdentityQueryPort, Depends(get_identity_port)]
PageDep = Annotated[PageParams, Depends(page_params)]
SettingsDep = Annotated[ProjectSettings, Depends(get_project_settings)]


@router.post("/projects", status_code=201, operation_id="createProject")
def create_project(
    body: ProjectCreateIn, user: CurrentUserDep, session: SessionDep, identity: IdentityDep
) -> dict[str, Any]:
    project_id = service.create_project(session, user, body)
    return views.detail_view(session, identity, service.read_project(session, user, project_id))


@router.get("/projects/{project_id}", operation_id="getProject")
def get_project(
    project_id: UUID, user: CurrentUserDep, session: SessionDep, identity: IdentityDep
) -> dict[str, Any]:
    return views.detail_view(session, identity, service.read_project(session, user, project_id))


@router.get("/projects", operation_id="listProjects")
def list_projects(
    user: CurrentUserDep,
    session: SessionDep,
    page: PageDep,
    scope: Literal["mine", "discover"] = "mine",
    status: Literal["ACTIVE", "ARCHIVED"] | None = None,
    q: Annotated[str | None, Query(max_length=200)] = None,
) -> dict[str, Any]:
    rows = repo.list_projects(
        session,
        user_id=user.user_id,
        scope=scope,
        status=status,
        q=(q or "").strip() or None,
        after=service.decode_after(page.cursor),
        limit=page.limit,
    )
    result = build_page(rows, page.limit, lambda row: [row["updated_at"].isoformat(), str(row["project_id"])])
    project_ids = [row["project_id"] for row in result.items]
    counts = repo.member_counts(session, project_ids)
    my_roles = repo.roles_for_user(session, project_ids, user.user_id)
    items = [
        views.summary_view(
            row, my_role=my_roles.get(row["project_id"]), member_count=counts.get(row["project_id"], 0)
        )
        for row in result.items
    ]
    return {"items": items, "page": result.page.model_dump()}


@router.patch("/projects/{project_id}", operation_id="updateProject")
def update_project(
    project_id: UUID, body: ProjectUpdateIn, user: CurrentUserDep, session: SessionDep, identity: IdentityDep
) -> dict[str, Any]:
    return views.detail_view(session, identity, service.update_project(session, user, project_id, body))


@router.post("/projects/{project_id}/archive", operation_id="archiveProject")
def archive_project(
    project_id: UUID, user: CurrentUserDep, session: SessionDep, identity: IdentityDep
) -> dict[str, Any]:
    return views.detail_view(session, identity, service.archive_project(session, user, project_id))


@router.get("/projects/{project_id}/members", operation_id="listProjectMembers")
def list_project_members(
    project_id: UUID, user: CurrentUserDep, session: SessionDep, identity: IdentityDep
) -> dict[str, Any]:
    return {"items": views.members_view(identity, service.read_members(session, user, project_id))}


@router.post("/projects/{project_id}/members", status_code=201, operation_id="addProjectMember")
def add_project_member(
    project_id: UUID,
    body: MemberAddIn,
    user: CurrentUserDep,
    session: SessionDep,
    identity: IdentityDep,
    settings: SettingsDep,
) -> dict[str, Any]:
    member = service.add_member(
        session, user, identity, project_id, body, max_members=settings.project_max_members
    )
    return views.members_view(identity, [member])[0]


@router.patch("/projects/{project_id}/members/{user_id}", operation_id="updateProjectMemberRole")
def update_project_member_role(
    project_id: UUID,
    user_id: UUID,
    body: MemberRoleIn,
    user: CurrentUserDep,
    session: SessionDep,
    identity: IdentityDep,
) -> dict[str, Any]:
    member = service.change_member_role(session, user, project_id, user_id, body.role)
    return views.members_view(identity, [member])[0]


@router.delete(
    "/projects/{project_id}/members/{user_id}",
    status_code=204,
    response_class=Response,
    operation_id="removeProjectMember",
)
def remove_project_member(
    project_id: UUID, user_id: UUID, user: CurrentUserDep, session: SessionDep
) -> Response:
    service.remove_member(session, user, project_id, user_id)
    return Response(status_code=204)
