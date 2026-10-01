"""Read side of the identity API: the caller, organizations, and the user directory."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from api.modules.identity.public import OrganizationSummary
from api.modules.identity.schemas import MeOut
from api.modules.identity.tables import memberships, organizations, users


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
            users.join(memberships, memberships.c.user_id == users.c.user_id).join(
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
