"""Read side of the identity API: the caller, organizations, and the user directory."""

from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, and_, func, or_, select
from sqlalchemy.orm import Session

from api.modules.identity.public import IdentityPublicProfile, OrganizationSummary
from api.modules.identity.schemas import MeOut, OrganizationOut
from api.modules.identity.tables import CURRENT_MEMBERSHIP, memberships, organizations, users
from api.platform.errors import ApiError
from api.platform.generated.error_codes import ErrorCode
from api.platform.pagination import Page, PageParams, build_page

MIN_QUERY_LENGTH = 2


def get_me(session: Session, user_id: UUID) -> MeOut:
    row = session.execute(
        select(
            users.c.user_id,
            users.c.display_name,
            users.c.email,
            users.c.status,
            users.c.platform_roles,
            memberships.c.roles,
            organizations.c.organization_id,
            organizations.c.code,
            organizations.c.name,
            organizations.c.type,
        )
        .select_from(
            users.join(memberships, and_(memberships.c.user_id == users.c.user_id, CURRENT_MEMBERSHIP)).join(
                organizations, organizations.c.organization_id == memberships.c.organization_id
            )
        )
        .where(users.c.user_id == user_id)
    ).one()
    return MeOut(
        user_id=row.user_id,
        display_name=row.display_name,
        email=row.email,
        status=row.status,
        organization=OrganizationSummary(
            organization_id=row.organization_id, code=row.code, name=row.name, type=row.type
        ),
        org_roles=sorted(row.roles),
        platform_roles=sorted(row.platform_roles),
    )


def invalid_cursor() -> ApiError:
    return ApiError(
        ErrorCode.VALIDATION_FAILED,
        "Invalid pagination cursor.",
        {"fields": [{"field": "cursor", "reason": "INVALID_CURSOR"}]},
    )


def cursor_key(params: PageParams) -> tuple[str, UUID] | None:
    """Decode our (sort text, id) cursor; anything else is a 422, never a 500."""
    if params.cursor is None:
        return None
    values = params.cursor
    if len(values) != 2 or not isinstance(values[0], str) or not isinstance(values[1], str):
        raise invalid_cursor()
    try:
        return values[0], UUID(values[1])
    except ValueError as exc:
        raise invalid_cursor() from exc


def after(sort_col: Any, id_col: Any, key: tuple[str, UUID]) -> ColumnElement[bool]:
    """Keyset predicate for ORDER BY sort_col, id_col."""
    text_value, id_value = key
    return or_(sort_col > text_value, and_(sort_col == text_value, id_col > id_value))


def escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def list_organizations(session: Session, params: PageParams) -> Page[OrganizationSummary]:
    stmt = select(
        organizations.c.organization_id, organizations.c.code, organizations.c.name, organizations.c.type
    )
    key = cursor_key(params)
    if key is not None:
        stmt = stmt.where(after(organizations.c.name, organizations.c.organization_id, key))
    rows = session.execute(
        stmt.order_by(organizations.c.name, organizations.c.organization_id).limit(params.limit + 1)
    ).all()
    items = [
        OrganizationSummary(organization_id=r.organization_id, code=r.code, name=r.name, type=r.type)
        for r in rows
    ]
    return build_page(items, params.limit, key=lambda org: (org.name, str(org.organization_id)))


def get_organization(session: Session, organization_id: UUID) -> OrganizationOut:
    member_count = (
        select(func.count())
        .select_from(memberships)
        .where(
            memberships.c.organization_id == organizations.c.organization_id,
            memberships.c.status == "ACTIVE",
            CURRENT_MEMBERSHIP,
        )
        .scalar_subquery()
    )
    row = session.execute(
        select(
            organizations.c.organization_id,
            organizations.c.code,
            organizations.c.name,
            organizations.c.type,
            organizations.c.ror_id,
            organizations.c.homepage_url,
            organizations.c.created_at,
            member_count.label("member_count"),
        ).where(organizations.c.organization_id == organization_id)
    ).first()
    if row is None:
        raise ApiError(ErrorCode.NOT_FOUND)
    return OrganizationOut(
        organization_id=row.organization_id,
        code=row.code,
        name=row.name,
        type=row.type,
        ror_id=row.ror_id,
        homepage_url=row.homepage_url,
        member_count=row.member_count,
        created_at=row.created_at,
    )


def search_users(
    session: Session, *, q: str | None, organization_id: UUID | None, params: PageParams
) -> Page[IdentityPublicProfile]:
    stmt = (
        select(
            users.c.user_id,
            users.c.display_name,
            memberships.c.organization_id,
            organizations.c.name.label("organization_name"),
        )
        .select_from(
            users.join(memberships, and_(memberships.c.user_id == users.c.user_id, CURRENT_MEMBERSHIP)).join(
                organizations, organizations.c.organization_id == memberships.c.organization_id
            )
        )
        .where(users.c.status == "ACTIVE", memberships.c.status == "ACTIVE")
    )
    if q is not None:
        term = q.strip()
        if len(term) < MIN_QUERY_LENGTH:
            raise ApiError(
                ErrorCode.VALIDATION_FAILED,
                "q needs at least 2 non-space characters.",
                {"fields": [{"field": "q", "reason": "TOO_SHORT"}]},
            )
        pattern = escape_like(term)
        stmt = stmt.where(
            or_(
                users.c.display_name.ilike(f"%{pattern}%", escape="\\"),
                users.c.email.like(f"{pattern.lower()}%", escape="\\"),
            )
        )
    if organization_id is not None:
        stmt = stmt.where(memberships.c.organization_id == organization_id)
    key = cursor_key(params)
    if key is not None:
        stmt = stmt.where(after(users.c.display_name, users.c.user_id, key))
    rows = session.execute(stmt.order_by(users.c.display_name, users.c.user_id).limit(params.limit + 1)).all()
    items = [
        IdentityPublicProfile(
            user_id=r.user_id,
            display_name=r.display_name,
            organization_id=r.organization_id,
            organization_name=r.organization_name,
            status="ACTIVE",
        )
        for r in rows
    ]
    return build_page(items, params.limit, key=lambda p: (p.display_name, str(p.user_id)))
