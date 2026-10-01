"""Organization member administration (spec §6 updateOrganizationMember, §9 authorization matrix)."""

from typing import Any
from uuid import UUID

from sqlalchemy import Row, Select, and_, any_, literal, select, update
from sqlalchemy.orm import Session

from api.modules.identity.directory import after, cursor_key
from api.modules.identity.schemas import MembershipOut, MemberUpdateIn
from api.modules.identity.tables import CURRENT_MEMBERSHIP, memberships, organizations, users
from api.platform import clock
from api.platform.auth import CurrentUser
from api.platform.errors import ApiError
from api.platform.events import EventActor
from api.platform.generated.error_codes import ErrorCode
from api.platform.generated.event_types import EventType
from api.platform.outbox import outbox
from api.platform.pagination import Page, PageParams, build_page

ORG_ADMIN = "ORG_ADMIN"
ORG_ROLES = frozenset({"ORG_ADMIN", "DATA_STEWARD", "RESOURCE_MANAGER"})


def ensure_organization(session: Session, organization_id: UUID, *, lock: bool = False) -> None:
    stmt = select(organizations.c.organization_id).where(organizations.c.organization_id == organization_id)
    if lock:
        stmt = stmt.with_for_update()  # serializes member updates within one organization
    found = session.execute(stmt).first()
    if found is None:
        raise ApiError(ErrorCode.NOT_FOUND)


def ensure_org_admin(user: CurrentUser, organization_id: UUID) -> None:
    if not (user.is_platform_admin or user.has_org_role(organization_id, ORG_ADMIN)):
        raise ApiError(ErrorCode.FORBIDDEN)


def membership_select() -> Select[Any]:
    return select(
        memberships.c.user_id,
        memberships.c.organization_id,
        memberships.c.roles,
        memberships.c.status,
        memberships.c.updated_at,
        memberships.c.started_at,
        users.c.display_name,
        users.c.email,
    ).select_from(memberships.join(users, and_(users.c.user_id == memberships.c.user_id, CURRENT_MEMBERSHIP)))


def membership_out(row: Row[Any]) -> MembershipOut:
    return MembershipOut(
        user_id=row.user_id,
        organization_id=row.organization_id,
        display_name=row.display_name,
        email=row.email,
        roles=sorted(row.roles),
        status=row.status,
        started_at=row.started_at,
        updated_at=row.updated_at,
    )


def list_members(session: Session, organization_id: UUID, params: PageParams) -> Page[MembershipOut]:
    stmt = membership_select().where(memberships.c.organization_id == organization_id, CURRENT_MEMBERSHIP)
    key = cursor_key(params)
    if key is not None:
        stmt = stmt.where(after(users.c.display_name, users.c.user_id, key))
    rows = session.execute(stmt.order_by(users.c.display_name, users.c.user_id).limit(params.limit + 1)).all()
    return build_page(
        [membership_out(row) for row in rows], params.limit, key=lambda m: (m.display_name, str(m.user_id))
    )


def validated_roles(roles: list[str]) -> list[str]:
    if len(set(roles)) != len(roles):
        raise ApiError(
            ErrorCode.VALIDATION_FAILED,
            "roles must not contain duplicates.",
            {"fields": [{"field": "roles", "reason": "DUPLICATE"}]},
        )
    invalid = sorted(set(roles) - ORG_ROLES)
    if invalid:
        raise ApiError(ErrorCode.ROLE_NOT_ASSIGNABLE, f"Not an organization role: {', '.join(invalid)}.")
    return sorted(roles)


def _active_admin_count(session: Session, organization_id: UUID) -> int:
    """Callers hold the organization row lock, so the count needs no row locks of its own."""
    rows = session.execute(
        select(memberships.c.user_id).where(
            memberships.c.organization_id == organization_id,
            memberships.c.status == "ACTIVE",
            CURRENT_MEMBERSHIP,
            literal(ORG_ADMIN) == any_(memberships.c.roles),
        )
    ).all()
    return len(rows)


def update_member(
    session: Session, actor: CurrentUser, organization_id: UUID, user_id: UUID, change: MemberUpdateIn
) -> MembershipOut:
    if change.roles is None and change.status is None:
        raise ApiError(
            ErrorCode.VALIDATION_FAILED,
            "Provide roles and/or status.",
            {"fields": [{"field": "body", "reason": "EMPTY"}]},
        )
    ensure_organization(session, organization_id, lock=True)
    ensure_org_admin(actor, organization_id)
    row = session.execute(
        membership_select()
        .where(
            memberships.c.organization_id == organization_id,
            memberships.c.user_id == user_id,
            CURRENT_MEMBERSHIP,
        )
        .with_for_update(of=memberships)
    ).first()
    if row is None:
        raise ApiError(ErrorCode.NOT_FOUND)

    previous_roles = sorted(row.roles)
    roles = validated_roles(change.roles) if change.roles is not None else previous_roles
    status = change.status or row.status
    if roles == previous_roles and status == row.status:
        return membership_out(row)

    loses_admin = (
        ORG_ADMIN in previous_roles
        and row.status == "ACTIVE"
        and (ORG_ADMIN not in roles or status != "ACTIVE")
    )
    if user_id == actor.user_id and status != "ACTIVE":
        raise ApiError(ErrorCode.ROLE_NOT_ASSIGNABLE, "You cannot disable your own membership.")
    if not actor.is_platform_admin:
        if user_id == actor.user_id and loses_admin:
            raise ApiError(ErrorCode.ROLE_NOT_ASSIGNABLE, "You cannot remove your own ORG_ADMIN role.")
        if loses_admin and _active_admin_count(session, organization_id) <= 1:
            raise ApiError(
                ErrorCode.ROLE_NOT_ASSIGNABLE, "Only a PLATFORM_ADMIN can remove the last ORG_ADMIN."
            )

    now = clock.now()
    session.execute(
        update(memberships)
        .where(
            memberships.c.organization_id == organization_id,
            memberships.c.user_id == user_id,
            CURRENT_MEMBERSHIP,
        )
        .values(roles=roles, status=status, updated_at=now, updated_by=actor.user_id)
    )
    outbox.write(
        session,
        EventType.IDENTITY_MEMBERSHIP_CHANGED_V1,
        {
            "user_id": str(user_id),
            "organization_id": str(organization_id),
            "previous_roles": previous_roles,
            "roles": roles,
            "previous_status": row.status,
            "status": status,
        },
        EventActor.for_user(actor),
    )
    return MembershipOut(
        user_id=user_id,
        organization_id=organization_id,
        display_name=row.display_name,
        email=row.email,
        roles=roles,
        status=status,
        started_at=row.started_at,
        updated_at=now,
    )
