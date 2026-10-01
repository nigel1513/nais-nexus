"""Project use cases (M02 §5-§7).

Every mutation first locks the projects row (SELECT ... FOR UPDATE) and only then reads memberships, so changes
to one project are serialized and "count(ACTIVE PROJECT_OWNER) >= 1" holds under concurrent requests (AT-14).
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import RowMapping
from sqlalchemy.orm import Session

from api.modules.project import repository as repo
from api.modules.project import roles
from api.modules.project.identity import IdentityQueryPort
from api.modules.project.schemas import MemberAddIn, ProjectCreateIn, ProjectUpdateIn, RoleName
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.ids import new_id
from api.platform.outbox import outbox

ARCHIVED = "ARCHIVED"
PUBLIC = "PUBLIC"


@dataclass(frozen=True)
class ProjectAccess:
    project: RowMapping
    my_role: str | None


def _validation_error(field: str, reason: str, message: str = "Request validation failed.") -> ApiError:
    return ApiError(ErrorCode.VALIDATION_FAILED, message, {"fields": [{"field": field, "reason": reason}]})


def _check_dates(start: date | None, end: date | None) -> None:
    if start is not None and end is not None and end < start:
        raise _validation_error("end_date", "END_BEFORE_START", "end_date must not be before start_date.")


def _access(session: Session, user: CurrentUser, project_id: UUID, *, lock: bool) -> ProjectAccess:
    project = repo.get_project(session, project_id, lock=lock)
    if project is None:
        raise ApiError(ErrorCode.NOT_FOUND)
    my_role = repo.member_role(session, project_id, user.user_id)
    if my_role is None and not user.is_platform_admin:
        if project["visibility"] == PUBLIC:
            raise ApiError(ErrorCode.FORBIDDEN)
        raise ApiError(ErrorCode.NOT_FOUND)
    return ProjectAccess(project, my_role)


def _mutable(
    session: Session, user: CurrentUser, project_id: UUID, *, allow_archived: bool = False
) -> ProjectAccess:
    access = _access(session, user, project_id, lock=True)
    if access.my_role is None:  # PLATFORM_ADMIN without membership: read-only
        raise ApiError(ErrorCode.FORBIDDEN)
    if not allow_archived and access.project["status"] == ARCHIVED:
        raise ApiError(ErrorCode.PROJECT_ARCHIVED)
    return access


def read_project(session: Session, user: CurrentUser, project_id: UUID) -> ProjectAccess:
    return _access(session, user, project_id, lock=False)


def create_project(session: Session, user: CurrentUser, data: ProjectCreateIn) -> UUID:
    _check_dates(data.start_date, data.end_date)
    now = clock.now()
    project_id = new_id()
    repo.insert_project(
        session,
        project_id=project_id,
        name=data.name,
        description=data.description,
        visibility=data.visibility,
        lead_organization_id=user.organization_id,
        keywords=list(data.keywords),
        start_date=data.start_date,
        end_date=data.end_date,
        created_by=user.user_id,
        now=now,
    )
    repo.insert_member(
        session,
        project_id=project_id,
        user_id=user.user_id,
        organization_id=user.organization_id,
        role=roles.OWNER,
        added_by=user.user_id,
        now=now,
    )
    repo.add_org_member(session, project_id, user.organization_id, lead=True)
    outbox.write(
        session,
        "project.created.v1",
        {
            "project_id": str(project_id),
            "name": data.name,
            "lead_organization_id": str(user.organization_id),
            "visibility": data.visibility,
            "owner_user_id": str(user.user_id),
        },
        EventActor.for_user(user),
    )
    return project_id


def decode_after(cursor: list[Any] | None) -> tuple[datetime, UUID] | None:
    """Decoded listProjects cursor -> (updated_at, project_id) keyset position."""
    if cursor is None:
        return None
    try:
        updated_at_raw, project_id_raw = cursor
        updated_at = datetime.fromisoformat(updated_at_raw)
        if updated_at.tzinfo is None:
            raise ValueError("cursor timestamp must carry a UTC offset")
        return updated_at, UUID(project_id_raw)
    except (TypeError, ValueError, AttributeError) as exc:
        raise _validation_error("cursor", "INVALID_CURSOR", "Invalid pagination cursor.") from exc


def _reload(session: Session, project_id: UUID, my_role: str | None) -> ProjectAccess:
    project = repo.get_project(session, project_id)
    assert project is not None  # locked by this transaction
    return ProjectAccess(project, my_role)


def update_project(
    session: Session, user: CurrentUser, project_id: UUID, patch: ProjectUpdateIn
) -> ProjectAccess:
    access = _mutable(session, user, project_id)
    if not roles.can_edit_project(access.my_role):
        raise ApiError(ErrorCode.FORBIDDEN)
    values = patch.model_dump(exclude_unset=True)
    visibility = values.get("visibility", access.project["visibility"])
    if visibility != access.project["visibility"] and not roles.can_change_visibility(access.my_role):
        raise ApiError(ErrorCode.FORBIDDEN, "Only PROJECT_OWNER can change visibility.")
    _check_dates(
        values.get("start_date", access.project["start_date"]),
        values.get("end_date", access.project["end_date"]),
    )
    repo.update_project(session, project_id, values, now=clock.now())
    return _reload(session, project_id, access.my_role)


def archive_project(session: Session, user: CurrentUser, project_id: UUID) -> ProjectAccess:
    access = _mutable(
        session, user, project_id
    )  # locked; an already ARCHIVED project -> 409, archived_at untouched
    if not roles.can_archive(access.my_role):
        raise ApiError(ErrorCode.FORBIDDEN)
    repo.archive_project(session, project_id, now=clock.now())
    outbox.write(session, "project.archived.v1", {"project_id": str(project_id)}, EventActor.for_user(user))
    return _reload(session, project_id, access.my_role)


def read_members(session: Session, user: CurrentUser, project_id: UUID) -> Sequence[RowMapping]:
    """ACTIVE members. Non-members get 404 whatever the visibility (M02 §6 listProjectMembers)."""
    if repo.get_project(session, project_id) is None:
        raise ApiError(ErrorCode.NOT_FOUND)
    if repo.member_role(session, project_id, user.user_id) is None and not user.is_platform_admin:
        raise ApiError(ErrorCode.NOT_FOUND)
    return repo.list_active_members(session, project_id)


def add_member(
    session: Session,
    user: CurrentUser,
    identity: IdentityQueryPort,
    project_id: UUID,
    data: MemberAddIn,
    *,
    max_members: int,
) -> RowMapping:
    access = _mutable(session, user, project_id)  # locks the project row before any member-row work
    if not roles.can_manage_member(access.my_role, data.role):
        raise ApiError(ErrorCode.FORBIDDEN)
    if repo.member_role(session, project_id, data.user_id) is not None:
        raise ApiError(ErrorCode.PROJECT_MEMBER_EXISTS)
    profile = identity.get_public_profile(data.user_id)
    if profile is None or not identity.is_active_user(data.user_id):
        raise _validation_error("user_id", "USER_NOT_ACTIVE", "User does not exist or is not active.")
    if repo.count_active_members(session, project_id) >= max_members:
        raise _validation_error(
            "user_id", "PROJECT_MAX_MEMBERS", f"A project can have at most {max_members} members."
        )
    organization_id = profile.organization_id
    now = clock.now()
    member = repo.insert_member(
        session,
        project_id=project_id,
        user_id=data.user_id,
        organization_id=organization_id,
        role=data.role,
        added_by=user.user_id,
        now=now,
    )
    repo.add_org_member(session, project_id, organization_id)
    repo.touch_project(session, project_id, now=now)
    outbox.write(
        session,
        "project.member.added.v1",
        {
            "project_id": str(project_id),
            "project_name": access.project["name"],
            "user_id": str(data.user_id),
            "organization_id": str(organization_id),
            "role": data.role,
            "added_by": str(user.user_id),
        },
        EventActor.for_user(user),
    )
    return member


def change_member_role(
    session: Session, user: CurrentUser, project_id: UUID, target_user_id: UUID, role: RoleName
) -> RowMapping:
    access = _mutable(session, user, project_id)  # locks the project row before any member-row work
    member = repo.active_member(session, project_id, target_user_id)
    if member is None:
        raise ApiError(ErrorCode.PROJECT_MEMBER_NOT_FOUND)
    current = member["role"]
    if not roles.can_manage_member(access.my_role, current, role):
        raise ApiError(ErrorCode.FORBIDDEN)
    if current == role:
        return member
    if roles.drops_an_owner(current, role) and repo.count_active_owners(session, project_id) <= 1:
        raise ApiError(ErrorCode.PROJECT_LAST_OWNER)
    updated = repo.set_member_role(session, member["project_member_id"], role)
    repo.touch_project(session, project_id, now=clock.now())
    outbox.write(
        session,
        "project.member.role_changed.v1",
        {
            "project_id": str(project_id),
            "user_id": str(target_user_id),
            "previous_role": current,
            "role": role,
            "changed_by": str(user.user_id),
        },
        EventActor.for_user(user),
    )
    return updated


def remove_member(session: Session, user: CurrentUser, project_id: UUID, target_user_id: UUID) -> None:
    leaving = target_user_id == user.user_id
    access = _mutable(session, user, project_id, allow_archived=leaving)  # locks the project row first
    member = repo.active_member(session, project_id, target_user_id)
    if member is None:
        raise ApiError(ErrorCode.PROJECT_MEMBER_NOT_FOUND)
    if not leaving and not roles.can_manage_member(access.my_role, member["role"]):
        raise ApiError(ErrorCode.FORBIDDEN)  # self-leave deliberately skips can_manage_member
    if roles.drops_an_owner(member["role"], None) and repo.count_active_owners(session, project_id) <= 1:
        raise ApiError(ErrorCode.PROJECT_LAST_OWNER)
    now = clock.now()
    if not repo.remove_member(session, member["project_member_id"], removed_by=user.user_id, now=now):
        raise ApiError(ErrorCode.PROJECT_MEMBER_NOT_FOUND)
    repo.drop_org_member(session, project_id, member["organization_id"])
    repo.touch_project(session, project_id, now=now)
    outbox.write(
        session,
        "project.member.removed.v1",
        {
            "project_id": str(project_id),
            "user_id": str(target_user_id),
            "organization_id": str(member["organization_id"]),
            "removed_by": str(user.user_id),
            "reason": None,
        },
        EventActor.for_user(user),
    )
