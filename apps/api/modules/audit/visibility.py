"""Audit visibility (M09 spec §6 / openapi listAuditEvents), applied as a mandatory SQL predicate.

- PLATFORM_ADMIN: everything.
- ORG_ADMIN / DATA_STEWARD: rows whose resource owner org is theirs, plus rows whose actor org is theirs EXCEPT
  download actions (a download of another org's data is visible only to that owner org: M09-AT-08).
- Everyone: own actions; with a project_id filter on a project they are a member of (ARCHIVED projects included,
  via ProjectQueryPort.list_project_ids_for_member), that project's rows except DOWNLOAD_DENIED.
DOWNLOAD_DENIED rows are therefore visible only to platform admin, the owner-org staff and the actor.
"""

from uuid import UUID

from sqlalchemy import ColumnElement, and_, or_, true

from api.modules.audit import ports as audit_ports
from api.modules.audit.tables import audit_events
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode

DOWNLOAD_ACTIONS = ("FILE_DOWNLOADED", "DOWNLOAD_DENIED")
STAFF_ROLES = ("ORG_ADMIN", "DATA_STEWARD")


def is_staff(user: CurrentUser) -> bool:
    return any(user.has_org_role(user.organization_id, role) for role in STAFF_ROLES)


def audit_scope(
    user: CurrentUser, *, project_id: UUID | None, organization_id: UUID | None
) -> ColumnElement[bool]:
    t = audit_events.c
    if user.is_platform_admin:
        return true()
    if organization_id is not None and organization_id != user.organization_id:
        raise ApiError(ErrorCode.FORBIDDEN, "organization_id is outside your organization.")
    staff = is_staff(user)
    clauses: list[ColumnElement[bool]] = [t.actor_user_id == user.user_id]
    if staff:
        clauses.append(t.resource_owner_organization_id == user.organization_id)
        clauses.append(
            and_(t.actor_organization_id == user.organization_id, t.action.not_in(DOWNLOAD_ACTIONS))
        )
    if project_id is not None:
        member_projects = audit_ports.projects().list_project_ids_for_member(user.user_id)
        if project_id in member_projects:
            clauses.append(and_(t.project_id == project_id, t.action != "DOWNLOAD_DENIED"))
        elif not staff:
            raise ApiError(ErrorCode.FORBIDDEN, "You are not a member of this project.")
    return or_(*clauses)
