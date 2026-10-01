"""SQL adapter for IdentityQueryPort. Each call is one short read transaction."""

from typing import Any
from uuid import UUID

from sqlalchemy import Select, and_, any_, literal, select
from sqlalchemy.orm import Session

from api.modules.identity.public import IdentityPublicProfile, OrganizationSummary, OrgRole
from api.modules.identity.resolver import SessionFactory
from api.modules.identity.tables import CURRENT_MEMBERSHIP, memberships, organizations, users
from api.platform.db import session_scope

_BOTH_ACTIVE = and_(users.c.status == "ACTIVE", memberships.c.status == "ACTIVE")


def _profiles_select() -> Select[Any]:
    return select(
        users.c.user_id,
        users.c.display_name,
        users.c.national_researcher_number,
        users.c.status.label("user_status"),
        memberships.c.status.label("membership_status"),
        memberships.c.organization_id,
        organizations.c.name.label("organization_name"),
    ).select_from(
        users.join(memberships, and_(memberships.c.user_id == users.c.user_id, CURRENT_MEMBERSHIP)).join(
            organizations, organizations.c.organization_id == memberships.c.organization_id
        )
    )


def _profile(row: Any) -> IdentityPublicProfile:
    active = row.user_status == "ACTIVE" and row.membership_status == "ACTIVE"
    return IdentityPublicProfile(
        user_id=row.user_id,
        display_name=row.display_name,
        organization_id=row.organization_id,
        organization_name=row.organization_name,
        status="ACTIVE" if active else "DISABLED",
        national_researcher_number=row.national_researcher_number,
    )


class SqlIdentityQuery:
    def __init__(self, sessions: SessionFactory = session_scope) -> None:
        self._sessions = sessions

    def _read(self) -> Any:
        return self._sessions()

    def get_public_profile(self, user_id: UUID) -> IdentityPublicProfile | None:
        return self.get_public_profiles([user_id]).get(user_id)

    def get_public_profiles(self, user_ids: list[UUID]) -> dict[UUID, IdentityPublicProfile]:
        if not user_ids:
            return {}
        with self._read() as session:
            rows = session.execute(_profiles_select().where(users.c.user_id.in_(user_ids))).all()
        return {row.user_id: _profile(row) for row in rows}

    def get_organization_summary(self, organization_id: UUID) -> OrganizationSummary | None:
        with self._read() as session:
            row = session.execute(
                select(
                    organizations.c.organization_id,
                    organizations.c.code,
                    organizations.c.name,
                    organizations.c.type,
                ).where(organizations.c.organization_id == organization_id)
            ).first()
        if row is None:
            return None
        return OrganizationSummary(
            organization_id=row.organization_id, code=row.code, name=row.name, type=row.type
        )

    def is_active_user(self, user_id: UUID) -> bool:
        with self._read() as session:
            return self._exists(session, users.c.user_id == user_id, _BOTH_ACTIVE)

    def has_org_role(self, user_id: UUID, organization_id: UUID, role: OrgRole) -> bool:
        with self._read() as session:
            return self._exists(
                session,
                users.c.user_id == user_id,
                memberships.c.organization_id == organization_id,
                literal(role) == any_(memberships.c.roles),
                _BOTH_ACTIVE,
            )

    def list_users_with_org_role(self, organization_id: UUID, role: OrgRole) -> list[UUID]:
        with self._read() as session:
            rows = session.execute(
                select(users.c.user_id)
                .select_from(
                    users.join(
                        memberships, and_(memberships.c.user_id == users.c.user_id, CURRENT_MEMBERSHIP)
                    )
                )
                .where(
                    memberships.c.organization_id == organization_id,
                    literal(role) == any_(memberships.c.roles),
                    _BOTH_ACTIVE,
                )
                .order_by(users.c.user_id)
            ).all()
        return [row.user_id for row in rows]

    def get_email(self, user_id: UUID) -> str | None:
        with self._read() as session:
            email = session.execute(
                select(users.c.email).where(users.c.user_id == user_id)
            ).scalar_one_or_none()
        return str(email) if email is not None else None

    @staticmethod
    def _exists(session: Session, *conditions: Any) -> bool:
        found = session.execute(
            select(users.c.user_id)
            .select_from(
                users.join(memberships, and_(memberships.c.user_id == users.c.user_id, CURRENT_MEMBERSHIP))
            )
            .where(*conditions)
            .limit(1)
        ).first()
        return found is not None
