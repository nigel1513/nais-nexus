"""Project use cases (M02 §5-§7).

Every mutation first locks the projects row (SELECT ... FOR UPDATE) and only then reads memberships, so changes
to one project are serialized and "count(ACTIVE PROJECT_OWNER) >= 1" holds under concurrent requests (AT-14).
"""

from dataclasses import dataclass
from datetime import date
from uuid import UUID

from sqlalchemy import RowMapping
from sqlalchemy.orm import Session

from api.modules.project import repository as repo
from api.modules.project import roles
from api.modules.project.schemas import ProjectCreateIn
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
